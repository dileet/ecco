import type { Message, MessageType, CapabilityQuery, CapabilityMatch } from '../types'
import type { NodeState, StateRef } from '../node/types'
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
import { ECCO_TESTNET, ECCO_MAINNET } from '../networks'
import {
  executeOrchestration,
  initialOrchestratorState,
  type OrchestratorState,
} from '../orchestrator'
import type { MultiAgentConfig, AgentResponse } from '../orchestrator/types'
import { delay } from '../utils'
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

function resolveBootstrapAddrs(network: AgentConfig['network']): string[] {
  if (!network) return []
  if (network === 'testnet') return ECCO_TESTNET.bootstrap.peers
  if (network === 'mainnet') return ECCO_MAINNET.bootstrap.peers
  if (Array.isArray(network)) return network
  return []
}

export async function createAgent(config: AgentConfig): Promise<Agent> {
  const bootstrapAddrs = resolveBootstrapAddrs(config.network)
  const hasBootstrap = bootstrapAddrs.length > 0

  const identity = await loadOrCreateNodeIdentity({
    nodeId: config.name,
    capabilities: config.capabilities,
    discovery: config.discovery ?? ['dht', 'gossip'],
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

  let orchestratorState: OrchestratorState = initialOrchestratorState
  let agentInstance: Agent | null = null

  const baseConfig = {
    discovery: config.discovery ?? ['dht', 'gossip'] as const,
    nodeId: config.name,
    capabilities: config.capabilities,
    transport: { websocket: { enabled: true } },
    ...(hasBootstrap && {
      bootstrap: {
        enabled: true,
        peers: bootstrapAddrs,
        timeout: 10000,
        minPeers: 1,
      },
    }),
    authentication: {
      enabled: true,
      walletRpcUrls: config.wallet?.rpcUrls,
    },
  }

  const messageHandler = config.handler ??
    (config.personality && config.model && (config.generateFn || config.streamGenerateFn)
      ? createLLMHandler({
          personality: config.personality,
          model: config.model,
          generateFn: config.generateFn,
          streamGenerateFn: config.streamGenerateFn,
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
          const invoiceResult = InvoiceSchema.safeParse(msg.payload)
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
            await baseCtx.reply(payload, type)
          }

          const streamResponse = async (
            generator: AsyncGenerator<StreamChunk> | (() => AsyncGenerator<StreamChunk>)
          ) => {
            const gen = typeof generator === 'function' ? generator() : generator
            let fullResponse = ''

            for await (const chunk of gen) {
              fullResponse += chunk.text

              if (config.pricing?.type === 'streaming' && chunk.tokens > 0) {
                const tempCtx: MessageContext = {
                  agent: agentInstance!,
                  message: msg,
                  reply: baseCtx.reply,
                  streamResponse: async () => {},
                }
                await payments.recordTokens(tempCtx, chunk.tokens, {
                  channelId,
                  pricing: config.pricing,
                  autoInvoice: true,
                })
              }

              await baseCtx.reply({ chunk: chunk.text, partial: true }, 'stream-chunk')
            }

            await baseCtx.reply({ text: fullResponse, complete: true }, 'stream-complete')
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

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Request timeout'))
      }, 30000)

      const libp2pPeerId = getLibp2pPeerId(baseAgent.ref)

      const handleResponse = (event: EccoEvent) => {
        if (event.type !== 'message') return
        const response = event.payload as Message
        if (response.type !== 'agent-response') return

        const responsePayload = response.payload as { requestId?: string; response?: unknown }
        if (responsePayload?.requestId !== requestMessage.id) return

        clearTimeout(timeout)
        resolve({
          peer: {
            id: peerId,
            addresses: [],
            capabilities: [],
            lastSeen: Date.now(),
          },
          matchScore: 1,
          response: responsePayload?.response ?? response.payload,
          timestamp: Date.now(),
          latency: Date.now() - requestMessage.timestamp,
          success: true,
        })
      }

      if (libp2pPeerId) {
        subscribeToTopic(baseAgent.ref, `peer:${libp2pPeerId}`, handleResponse)
      }

      sendMessage(baseAgent.ref, peerId, requestMessage).catch((error) => {
        clearTimeout(timeout)
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

    const capabilityQuery: CapabilityQuery = {
      requiredCapabilities: [{ type: 'agent' }],
    }

    const payload = { prompt: options.query }

    const { result, state } = await executeOrchestration(
      baseAgent.ref,
      orchestratorState,
      capabilityQuery,
      payload,
      mergedConfig
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
      requiredCapabilities: [{ type: 'agent' }],
    }

    const peers = await findPeersWithPriority(baseAgent.ref, capabilityQuery, {
      phases: discoveryConfig.phases as DiscoveryPriority[],
      phaseTimeout: discoveryConfig.phaseTimeout ?? 5000,
      minPeers: discoveryConfig.minPeers ?? 1,
      preferProximity: discoveryConfig.preferProximity ?? true,
    })

    if (peers.length === 0) {
      throw new Error('No peers discovered for query')
    }

    return requestConsensus({
      query: prompt,
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
  }

  agentInstance = {
    id: baseAgent.id,
    addrs: baseAgent.addrs,
    ref: baseAgent.ref,
    wallet: walletState,
    address: walletState ? getAddress(walletState) : null,
    capabilities: config.capabilities,
    payments,
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
