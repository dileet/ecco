import type { Message, MessageType, CapabilityQuery, CapabilityMatch, EmbeddingCapability, ModelCapability } from '../types'
import {
  createAgent as createBaseAgent,
  stop as stopNode,
  broadcastCapabilities,
  findPeers as findPeersBase,
  findPeersWithPriority,
  sendMessage,
  getLibp2pPeerId,
  subscribeToTopic,
  loadOrCreateNodeIdentity,
} from '../node'
import { createWalletState, getAddress, type WalletState } from '../services/wallet'
import { ECCO_TESTNET, ECCO_MAINNET, formatProtocolVersion, type NetworkConfig } from '../networks'
import {
  executeOrchestration,
  initialOrchestratorState,
  type OrchestratorState,
} from '../orchestrator'
import type { MultiAgentConfig, AgentResponse } from '../orchestrator/types'
import { delay, debug } from '../utils'
import type {
  AgentConfig,
  Agent,
  MessageContext,
  ConsensusRequestOptions,
  ConsensusResult,
  StreamChunk,
  QueryConfig,
  DiscoveryOptions,
  DiscoveryPriority,
} from './types'
import { createLLMHandler } from './handlers'
import { createPaymentHelpers, createPaymentState, handlePaymentProof, setupEscrowAgreement } from './payments'
import { setupEmbeddingProvider } from '../services/embedding'
import { setupGenerationProvider } from '../services/generation'
import { createLocalModel, createLocalGenerateFn, createLocalStreamGenerateFn, createLocalEmbedFn, unloadModel, isLocalModelState, type LocalModelState } from '../services/llm'
import type { EccoEvent } from '../events'
import { z } from 'zod'

const PaymentProofSchema = z.object({
  invoiceId: z.string(),
  txHash: z.string(),
  chainId: z.number(),
})

const InvoiceSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  chainId: z.number(),
  amount: z.string(),
  token: z.string(),
  recipient: z.string(),
  validUntil: z.number(),
})

const StreamingTickSchema = z.object({
  channelId: z.string().optional(),
  tokensGenerated: z.number(),
})

function getExplicitTokens(payload: unknown): number | null {
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    if (typeof obj.tokens === 'number') {
      return obj.tokens
    }
  }
  return null
}

function resolveNetworkConfig(network: AgentConfig['network']): NetworkConfig {
  if (Array.isArray(network)) return ECCO_MAINNET
  if (network === 'testnet') return ECCO_TESTNET
  return ECCO_MAINNET
}

function resolveBootstrapAddrs(network: AgentConfig['network']): string[] {
  if (!network) return []
  if (network === 'testnet') return ECCO_TESTNET.bootstrap.peers
  if (network === 'mainnet') return ECCO_MAINNET.bootstrap.peers
  if (Array.isArray(network)) return network
  return []
}

export async function createAgent(config: AgentConfig): Promise<Agent> {
  const networkConfig = resolveNetworkConfig(config.network)
  const bootstrapAddrs = resolveBootstrapAddrs(config.network)
  const hasBootstrap = bootstrapAddrs.length > 0

  const identity = await loadOrCreateNodeIdentity({
    nodeId: config.name,
    capabilities: config.capabilities,
    discovery: networkConfig.discovery,
  })

  const ethereumPrivateKey = config.wallet?.privateKey
    ? (config.wallet.privateKey as `0x${string}`)
    : identity.ethereumPrivateKey

  let walletState: WalletState | null = null
  if (ethereumPrivateKey) {
    walletState = createWalletState({
      privateKey: ethereumPrivateKey,
      rpcUrls: config.wallet?.rpcUrls,
    })
  }

  const paymentState = createPaymentState()
  const payments = createPaymentHelpers(walletState, paymentState)

  let modelState: LocalModelState | null = isLocalModelState(config.model) ? config.model : null
  let embeddingModelState: LocalModelState | null = isLocalModelState(config.embedding) ? config.embedding : null
  let effectiveGenerateFn = config.generateFn
  let effectiveStreamGenerateFn = config.streamGenerateFn
  let effectiveModel = config.model
  let effectiveEmbedFn = embeddingModelState
    ? createLocalEmbedFn(embeddingModelState)
    : (!isLocalModelState(config.embedding) ? config.embedding?.embedFn : undefined)

  if (config.localModel) {
    modelState = await createLocalModel({
      modelPath: config.localModel.modelPath,
      contextSize: config.localModel.contextSize,
      gpuLayers: config.localModel.gpuLayers,
      threads: config.localModel.threads,
      embedding: config.localModel.supportsEmbedding,
    })
    effectiveGenerateFn = createLocalGenerateFn(modelState)
    effectiveStreamGenerateFn = createLocalStreamGenerateFn(modelState)
    effectiveModel = config.localModel.modelName ?? config.localModel.modelPath
  }

  const hasEmbeddingConfig = config.embedding !== undefined
  const hasLocalModel = config.localModel !== undefined

  const embeddingModelId = embeddingModelState
    ? embeddingModelState.config.modelPath
    : isLocalModelState(config.embedding) ? undefined : config.embedding?.modelId

  const versionString = formatProtocolVersion(networkConfig.protocol.currentVersion)

  const embeddingCapability: EmbeddingCapability | null = hasEmbeddingConfig && embeddingModelId
    ? {
        type: 'embedding',
        name: embeddingModelId,
        version: versionString,
        provider: 'self',
        model: embeddingModelId,
      }
    : null

  const modelCapability: ModelCapability | null = hasLocalModel
    ? {
        type: 'model',
        name: config.localModel!.modelName ?? 'local-model',
        version: versionString,
        modelType: config.localModel!.supportsEmbedding ? 'both' : 'text-generation',
        modelName: config.localModel!.modelName ?? config.localModel!.modelPath,
        contextLength: config.localModel!.contextSize,
      }
    : null

  let allCapabilities = [...config.capabilities]
  if (embeddingCapability) {
    allCapabilities.push(embeddingCapability)
  }
  if (modelCapability) {
    allCapabilities.push(modelCapability)
  }

  let orchestratorState: OrchestratorState = initialOrchestratorState
  let agentInstance: Agent | null = null

  const bluetoothConfig = config.transports?.bluetooth
  const hasBluetoothEnabled = bluetoothConfig?.enabled === true

  const baseConfig = {
    discovery: networkConfig.discovery,
    nodeId: config.name,
    capabilities: allCapabilities,
    transport: { websocket: { enabled: true } },
    ...(hasBootstrap && {
      bootstrap: {
        enabled: true,
        peers: bootstrapAddrs,
        timeout: 10000,
        minPeers: 1,
      },
    }),
    ...(hasBluetoothEnabled && {
      proximity: {
        bluetooth: {
          enabled: true,
          advertise: bluetoothConfig.role === 'peripheral' || bluetoothConfig.role === 'both' || bluetoothConfig.role === undefined,
          scan: bluetoothConfig.role === 'central' || bluetoothConfig.role === 'both' || bluetoothConfig.role === undefined,
          serviceUUID: bluetoothConfig.serviceUUID,
        },
        localContext: {
          locationName: bluetoothConfig.localName ?? config.name,
          capabilities: allCapabilities.map(c => c.name),
        },
      },
    }),
    authentication: {
      enabled: true,
      walletRpcUrls: config.wallet?.rpcUrls,
    },
  }

  const defaultSystemPrompt = 'You are a helpful assistant.'

  const messageHandler = config.handler ??
    (effectiveModel && (effectiveGenerateFn || effectiveStreamGenerateFn)
      ? createLLMHandler({
          systemPrompt: config.systemPrompt ?? defaultSystemPrompt,
          model: effectiveModel,
          generateFn: effectiveGenerateFn,
          streamGenerateFn: effectiveStreamGenerateFn,
        })
      : undefined)

  const baseAgent = await createBaseAgent(
    baseConfig,
    {
      onMessage: async (msg: Message, baseCtx) => {
        if (msg.type === 'submit-payment-proof') {
          const proofResult = PaymentProofSchema.safeParse(msg.payload)
          if (proofResult.success) {
            handlePaymentProof(paymentState, proofResult.data)
          }
          return
        }

        if (msg.type === 'invoice') {
          const payload = msg.payload as { invoice?: unknown; response?: { invoice?: unknown } | unknown }
          const invoiceData = payload?.invoice ?? (payload?.response as { invoice?: unknown })?.invoice ?? payload?.response ?? msg.payload
          const invoiceResult = InvoiceSchema.safeParse(invoiceData)
          if (invoiceResult.success) {
            payments.queueInvoice(invoiceResult.data)
          }
        }

        if (msg.type === 'streaming-tick' && config.pricing?.type === 'streaming') {
          const tickResult = StreamingTickSchema.safeParse(msg.payload)
          if (tickResult.success) {
            const ctx: MessageContext = {
              agent: agentInstance!,
              message: msg,
              reply: baseCtx.reply,
              streamResponse: async () => {},
            }
            await payments.recordTokens(ctx, tickResult.data.tokensGenerated, {
              channelId: tickResult.data.channelId,
              pricing: config.pricing,
              autoInvoice: true,
            })
          }
        }

        if (msg.type === 'agent-request' && config.pricing?.type === 'escrow' && walletState) {
          await setupEscrowAgreement(
            paymentState,
            msg.id,
            msg.from,
            getAddress(walletState),
            config.pricing
          )
        }

        if (messageHandler && msg.type === 'agent-request') {
          const channelId = msg.id

          const wrappedReply = async (payload: unknown, type?: MessageType) => {
            if (config.pricing?.type === 'streaming' && type !== 'invoice') {
              const tokens = getExplicitTokens(payload)
              if (tokens !== null && tokens > 0) {
                const tempCtx: MessageContext = {
                  agent: agentInstance!,
                  message: msg,
                  reply: baseCtx.reply,
                  streamResponse: async () => {},
                }
                await payments.recordTokens(tempCtx, tokens, {
                  channelId,
                  pricing: config.pricing,
                  autoInvoice: true,
                })
              }
            }
            await baseCtx.reply({ requestId: msg.id, response: payload }, type ?? 'agent-response')
          }

          const streamResponse = async (
            generator: AsyncGenerator<StreamChunk> | (() => AsyncGenerator<StreamChunk>)
          ) => {
            const gen = typeof generator === 'function' ? generator() : generator
            let fullResponse = ''
            let totalTokens = 0

            for await (const chunk of gen) {
              fullResponse += chunk.text

              if (config.pricing?.type === 'streaming' && chunk.tokens && chunk.tokens > 0) {
                totalTokens += chunk.tokens
                const tempCtx: MessageContext = {
                  agent: agentInstance!,
                  message: msg,
                  reply: baseCtx.reply,
                  streamResponse: async () => {},
                }
                await payments.recordTokens(tempCtx, chunk.tokens, {
                  channelId,
                  pricing: config.pricing,
                  autoInvoice: false,
                })
              }

              await baseCtx.reply({ requestId: msg.id, chunk: chunk.text, partial: true }, 'stream-chunk')
            }

            if (config.pricing?.type === 'streaming' && totalTokens > 0) {
              const tempCtx: MessageContext = {
                agent: agentInstance!,
                message: msg,
                reply: baseCtx.reply,
                streamResponse: async () => {},
              }
              await payments.sendStreamingInvoice(tempCtx, channelId)
            }

            await baseCtx.reply({ requestId: msg.id, text: fullResponse, complete: true }, 'stream-complete')
            await baseCtx.reply({ requestId: msg.id, response: { text: fullResponse, finishReason: 'stop' } }, 'agent-response')
          }

          const ctx: MessageContext = {
            agent: agentInstance!,
            message: msg,
            reply: wrappedReply,
            streamResponse,
          }
          await messageHandler(msg, ctx)
        }
      },
    }
  )

  await delay(1000)
  await broadcastCapabilities(baseAgent.ref)
  await delay(500)

  if (hasEmbeddingConfig && effectiveEmbedFn && embeddingModelId) {
    setupEmbeddingProvider({
      nodeRef: baseAgent.ref,
      embedFn: effectiveEmbedFn,
      modelId: embeddingModelId,
      libp2pPeerId: getLibp2pPeerId(baseAgent.ref),
    })
  }

  if (hasLocalModel && effectiveGenerateFn) {
    setupGenerationProvider({
      nodeRef: baseAgent.ref,
      generateFn: effectiveGenerateFn,
      streamGenerateFn: effectiveStreamGenerateFn,
      modelId: config.localModel!.modelName ?? 'local-model',
      libp2pPeerId: getLibp2pPeerId(baseAgent.ref),
    })

    if (config.localModel!.supportsEmbedding && modelState) {
      const localEmbedFn = createLocalEmbedFn(modelState)
      setupEmbeddingProvider({
        nodeRef: baseAgent.ref,
        embedFn: localEmbedFn,
        modelId: config.localModel!.modelName ?? 'local-embed',
        libp2pPeerId: getLibp2pPeerId(baseAgent.ref),
      })
    }
  }

  const embed = effectiveEmbedFn
    ? async (texts: string[]): Promise<number[][]> => effectiveEmbedFn(texts)
    : (hasLocalModel && config.localModel?.supportsEmbedding && modelState
      ? async (texts: string[]): Promise<number[][]> => createLocalEmbedFn(modelState!)(texts)
      : null)

  const findPeers = async (query?: CapabilityQuery): Promise<CapabilityMatch[]> => {
    const effectiveQuery: CapabilityQuery = query ?? { requiredCapabilities: [] }
    return findPeersBase(baseAgent.ref, effectiveQuery)
  }

  const request = async (peerId: string, prompt: string): Promise<AgentResponse> => {
    const requestMessage: Message = {
      id: crypto.randomUUID(),
      from: baseAgent.id,
      to: peerId,
      type: 'agent-request',
      payload: { prompt },
      timestamp: Date.now(),
    }

    debug('request', `Sending request ${requestMessage.id} from ${baseAgent.id} to ${peerId}`)

    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | undefined

      const cleanup = () => {
        if (unsubscribe) {
          unsubscribe()
        }
      }

      const timeout = setTimeout(() => {
        debug('request', `TIMEOUT waiting for response to ${requestMessage.id}`)
        cleanup()
        reject(new Error('Request timeout'))
      }, 30000)

      const libp2pPeerId = getLibp2pPeerId(baseAgent.ref)
      debug('request', `Subscribing to topic peer:${libp2pPeerId}`)

      const handleResponse = (event: EccoEvent) => {
        debug('request', `Received event type=${event.type}`)
        if (event.type !== 'message') return
        const response = event.payload as Message
        debug('request', `Message type=${response.type}, from=${response.from}`)
        if (response.type !== 'agent-response') return

        const responsePayload = response.payload as { requestId?: string; response?: unknown }
        debug('request', `Response requestId=${responsePayload?.requestId}, expected=${requestMessage.id}`)
        if (responsePayload?.requestId !== requestMessage.id) return

        debug('request', 'MATCHED! Resolving response')
        clearTimeout(timeout)
        cleanup()
        resolve({
          peer: {
            id: peerId,
            addresses: [],
            capabilities: [],
            lastSeen: Date.now(),
          },
          matchScore: 1,
          response: responsePayload?.response || response.payload,
          timestamp: Date.now(),
          latency: Date.now() - requestMessage.timestamp,
          success: true,
        })
      }

      if (libp2pPeerId) {
        unsubscribe = subscribeToTopic(baseAgent.ref, `peer:${libp2pPeerId}`, handleResponse)
      }

      sendMessage(baseAgent.ref, peerId, requestMessage).catch((error) => {
        clearTimeout(timeout)
        cleanup()
        reject(error)
      })
    })
  }

  const requestConsensus = async (options: ConsensusRequestOptions): Promise<ConsensusResult> => {
    const defaultConfig: MultiAgentConfig = {
      selectionStrategy: 'all',
      aggregationStrategy: 'consensus-threshold',
      consensusThreshold: 0.6,
      timeout: 60000,
      allowPartialResults: true,
    }

    const mergedConfig: MultiAgentConfig = {
      ...defaultConfig,
      ...options.config,
    }

    if (effectiveEmbedFn && mergedConfig.semanticSimilarity?.enabled) {
      mergedConfig.semanticSimilarity = {
        ...mergedConfig.semanticSimilarity,
        localEmbedFn: effectiveEmbedFn,
      }
    }

    const capabilityQuery: CapabilityQuery = options.capabilityQuery ?? {
      requiredCapabilities: [],
    }

    const payload = { prompt: options.query }

    const { result, state } = await executeOrchestration(
      baseAgent.ref,
      orchestratorState,
      capabilityQuery,
      payload,
      mergedConfig,
      options.additionalResponses ?? []
    )

    orchestratorState = state

    const textResponse = extractTextFromResult(result.result)

    return {
      text: textResponse,
      consensus: {
        achieved: result.consensus.achieved,
        confidence: result.consensus.confidence,
      },
      metrics: {
        totalAgents: result.metrics.totalAgents,
        successfulAgents: result.metrics.successfulAgents,
        averageLatency: result.metrics.averageLatency,
      },
      agentResponses: result.responses,
      raw: result,
    }
  }

  const query = async (prompt: string, queryConfig?: QueryConfig): Promise<ConsensusResult> => {
    const defaultDiscovery: DiscoveryOptions = {
      phases: ['proximity', 'local', 'internet', 'fallback'] as DiscoveryPriority[],
      phaseTimeout: 5000,
      preferProximity: true,
      minPeers: 1,
    }

    const discoveryConfig = {
      ...defaultDiscovery,
      ...queryConfig?.discovery,
    }

    const capabilityQuery: CapabilityQuery = queryConfig?.discovery?.capabilityQuery ?? {
      requiredCapabilities: [],
    }

    const peers = await findPeersWithPriority(baseAgent.ref, capabilityQuery, {
      phases: discoveryConfig.phases as DiscoveryPriority[],
      phaseTimeout: discoveryConfig.phaseTimeout ?? 5000,
      minPeers: discoveryConfig.minPeers ?? 1,
      preferProximity: discoveryConfig.preferProximity ?? true,
    })

    if (peers.length === 0 && !queryConfig?.includeSelf) {
      throw new Error('No peers discovered for query')
    }

    const additionalResponses: AgentResponse[] = []

    if (queryConfig?.includeSelf && effectiveModel && (effectiveGenerateFn || effectiveStreamGenerateFn)) {
      const startTime = Date.now()
      const systemPrompt = queryConfig.systemPrompt
        ?? config.systemPrompt
        ?? defaultSystemPrompt

      try {
        let responseText = ''

        if (effectiveStreamGenerateFn) {
          const generator = effectiveStreamGenerateFn({
            model: effectiveModel,
            system: systemPrompt,
            prompt,
          })
          for await (const chunk of generator) {
            responseText += chunk.text
            if (queryConfig?.onStream) {
              queryConfig.onStream({ ...chunk, peerId: baseAgent.id })
            }
          }
        } else if (effectiveGenerateFn) {
          const result = await effectiveGenerateFn({
            model: effectiveModel,
            system: systemPrompt,
            prompt,
          })
          responseText = result.text
        }

        additionalResponses.push({
          peer: {
            id: baseAgent.id,
            addresses: baseAgent.addrs,
            capabilities: allCapabilities,
            lastSeen: Date.now(),
          },
          matchScore: 1,
          response: { text: responseText },
          timestamp: Date.now(),
          latency: Date.now() - startTime,
          success: true,
        })
      } catch (error) {
        additionalResponses.push({
          peer: {
            id: baseAgent.id,
            addresses: baseAgent.addrs,
            capabilities: allCapabilities,
            lastSeen: Date.now(),
          },
          matchScore: 1,
          response: null,
          timestamp: Date.now(),
          latency: Date.now() - startTime,
          error: error as Error,
          success: false,
        })
      }
    }

    const createSynthesizeFn = () => {
      if (queryConfig?.aggregationStrategy !== 'synthesized-consensus') return undefined
      if (!effectiveGenerateFn && !effectiveStreamGenerateFn) {
        throw new Error('synthesized-consensus requires a model with generateFn or streamGenerateFn')
      }

      return async (query: string, responses: AgentResponse[]): Promise<string> => {
        const responseTexts = responses.map((r) => {
          const text = typeof r.response === 'object' && r.response !== null && 'text' in r.response
            ? (r.response as { text: string }).text
            : String(r.response)
          return `[${r.peer.id}]: ${text}`
        }).join('\n\n')

        const synthesisPrompt = `Original question: "${query}"

Agent responses:
${responseTexts}

Provide a unified consensus answer that incorporates the key insights from all perspectives. Be concise (2-3 sentences).`

        if (effectiveGenerateFn) {
          const result = await effectiveGenerateFn({
            model: effectiveModel,
            system: 'You synthesize multiple perspectives into a unified consensus answer.',
            prompt: synthesisPrompt,
          })
          return result.text
        }

        let responseText = ''
        const gen = effectiveStreamGenerateFn!({
          model: effectiveModel,
          system: 'You synthesize multiple perspectives into a unified consensus answer.',
          prompt: synthesisPrompt,
        })
        for await (const chunk of gen) {
          responseText += chunk.text
        }
        return responseText
      }
    }

    return requestConsensus({
      query: prompt,
      capabilityQuery,
      additionalResponses,
      config: {
        selectionStrategy: queryConfig?.selectionStrategy ?? 'all',
        aggregationStrategy: queryConfig?.aggregationStrategy ?? 'consensus-threshold',
        consensusThreshold: queryConfig?.consensusThreshold ?? 0.6,
        timeout: queryConfig?.timeout ?? 60000,
        allowPartialResults: queryConfig?.allowPartialResults ?? true,
        agentCount: queryConfig?.agentCount,
        minAgents: queryConfig?.minAgents ?? 1,
        semanticSimilarity: queryConfig?.semanticSimilarity,
        loadBalancing: queryConfig?.loadBalancing,
        onStream: queryConfig?.onStream
          ? (chunk) => queryConfig.onStream!({ text: chunk.text, peerId: chunk.peerId })
          : undefined,
        originalQuery: prompt,
        synthesizeFn: createSynthesizeFn(),
      },
    })
  }

  const send = async (peerId: string, type: MessageType, payload: unknown): Promise<void> => {
    const message: Message = {
      id: crypto.randomUUID(),
      from: baseAgent.id,
      to: peerId,
      type,
      payload,
      timestamp: Date.now(),
    }
    await sendMessage(baseAgent.ref, peerId, message)
  }

  const stop = async (): Promise<void> => {
    await stopNode(baseAgent.ref)
    if (modelState) {
      await unloadModel(modelState)
    }
    if (embeddingModelState) {
      await unloadModel(embeddingModelState)
    }
  }

  agentInstance = {
    id: baseAgent.id,
    addrs: baseAgent.addrs,
    ref: baseAgent.ref,
    wallet: walletState,
    address: walletState ? getAddress(walletState) : null,
    capabilities: allCapabilities,
    payments,
    hasEmbedding: hasEmbeddingConfig || (hasLocalModel && config.localModel?.supportsEmbedding === true),
    protocolVersion: networkConfig.protocol.currentVersion,
    embed,
    findPeers,
    request,
    requestConsensus,
    send,
    stop,
    query,
  }

  return agentInstance
}

function extractTextFromResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.content === 'string') return obj.content
    if (Array.isArray(obj.content) && obj.content[0]?.text) {
      return String(obj.content[0].text)
    }
    return JSON.stringify(result)
  }
  return String(result)
}

export * from './types'
export { extractPromptText, createLLMHandler, isAgentRequest } from './handlers'
export { createPaymentHelpers, createPaymentState } from './payments'
