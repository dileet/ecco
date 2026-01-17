import type { Message, CapabilityQuery, CapabilityMatch, EmbeddingCapability, ModelCapability } from '../types'
import {
  createAgent as createBaseAgent,
  stop as stopNode,
  broadcastCapabilities,
  findPeers as findPeersBase,
  findPeersWithPriority,
  getLibp2pPeerId,
  loadOrCreateNodeIdentity,
  resolveWalletForPeer,
} from '../networking'
import type { StateRef } from '../networking/types'
import { getAddress, getPublicClient, getWalletClient, type WalletState } from '../payments/wallet'
import { formatProtocolVersion } from '../networks'
import {
  createIdentityRegistryState,
  createStakeRegistryState,
  getAgentByPeerId,
  fetchStakeInfo,
  canWork,
  registerAgent,
  bindPeerId,
} from '../identity'
import type { StakeInfo } from '../identity'
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
  ConsensusRequestOptions,
  ConsensusResult,
  QueryConfig,
  DiscoveryOptions,
  DiscoveryPriority,
  FindPeersOptions,
} from './types'
import { createLLMHandler } from './handlers'
import { setupEmbeddingProvider } from '../llm/embedding-service'
import { setupGenerationProvider } from '../llm/generation-service'
import { createLocalEmbedFn, unloadModel } from '../llm/local-model'
import { resolveNetworkConfig, resolveBootstrapAddrs, resolveChainId, mergeRpcUrls } from './network'
import { setupWallet } from './wallet'
import { setupModels, createEmbedFunction } from './models'
import { createMessageDispatcher } from './dispatch'
import { createRequestMethod, createSendMethod } from './requests'
import { createStakingMethods } from '../reputation/staking'

type StopFn = () => Promise<void>
const activeAgents = new Map<string, StopFn>()
let cleanupRegistered = false

function registerProcessCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true

  const cleanup = async (): Promise<void> => {
    const stops = Array.from(activeAgents.values())
    activeAgents.clear()
    await Promise.allSettled(stops.map(fn => fn()))
  }

  process.on('beforeExit', () => {
    cleanup()
  })

  process.on('SIGINT', () => {
    cleanup().then(() => process.exit(0))
  })

  process.on('SIGTERM', () => {
    cleanup().then(() => process.exit(0))
  })
}

export async function createAgent(config: AgentConfig): Promise<Agent> {
  const networkConfig = resolveNetworkConfig(config.network)
  const bootstrapAddrs = resolveBootstrapAddrs(config.network, config.bootstrap)
  const hasBootstrap = bootstrapAddrs.length > 0
  const chainId = resolveChainId(config.network, config.reputation)
  const rpcUrls = mergeRpcUrls(config.wallet?.rpcUrls)

  const identity = await loadOrCreateNodeIdentity({
    nodeId: config.name,
    capabilities: config.capabilities,
    discovery: networkConfig.discovery,
  })

  const ethereumPrivateKey = config.wallet?.privateKey
    ? (config.wallet.privateKey as `0x${string}`)
    : identity.ethereumPrivateKey

  const { walletState, reputationState, paymentState, payments, fees } = setupWallet({
    ethereumPrivateKey,
    rpcUrls,
    chainId,
    libp2pPrivateKey: identity.libp2pPrivateKey,
    reputation: config.reputation,
  })

  const {
    modelState,
    embeddingModelState,
    effectiveGenerateFn,
    effectiveStreamGenerateFn,
    effectiveEmbedFn,
    effectiveModel,
    embeddingModelId,
  } = await setupModels({
    model: config.model,
    localModel: config.localModel,
    embedding: config.embedding,
    generateFn: config.generateFn,
    streamGenerateFn: config.streamGenerateFn,
  })

  const hasEmbeddingConfig = config.embedding !== undefined
  const hasLocalModel = config.localModel !== undefined
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
  if (embeddingCapability) allCapabilities.push(embeddingCapability)
  if (modelCapability) allCapabilities.push(modelCapability)

  let agentInstance: Agent | null = null
  const getAgent = () => agentInstance

  const bluetoothConfig = config.transports?.bluetooth
  const hasBluetoothEnabled = bluetoothConfig?.enabled === true

  const baseConfig = {
    discovery: networkConfig.discovery,
    nodeId: config.name,
    networkId: networkConfig.networkId,
    protocol: networkConfig.protocol,
    constitution: networkConfig.constitution,
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
          constitution: networkConfig.constitution,
        })
      : undefined)

  const onMessage = createMessageDispatcher({
    getAgent,
    paymentState,
    walletState,
    pricing: config.pricing,
    payments,
    messageHandler,
  })

  const baseAgent = await createBaseAgent(baseConfig, { onMessage })

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

  const embed = createEmbedFunction(effectiveEmbedFn, hasLocalModel, config.localModel, modelState)

  const identityRegistryAddress: `0x${string}` = '0x0000000000000000000000000000000000000000'
  const stakeRegistryAddress: `0x${string}` = '0x0000000000000000000000000000000000000000'
  const identityState = createIdentityRegistryState(chainId, identityRegistryAddress)
  const stakeState = createStakeRegistryState(chainId, stakeRegistryAddress, identityRegistryAddress)

  const findPeers = async (query?: FindPeersOptions): Promise<CapabilityMatch[]> => {
    const effectiveQuery: CapabilityQuery = query ?? { requiredCapabilities: [] }
    const peers = await findPeersBase(baseAgent.ref, effectiveQuery)

    if (!query?.requireStake && !query?.minStake) return peers
    if (!walletState || !reputationState) return peers

    const publicClient = getPublicClient(walletState, chainId)
    const filteredPeers: CapabilityMatch[] = []

    for (const match of peers) {
      const peerWallet = await resolveWalletForPeer(reputationState, walletState, match.peer.id)
      if (!peerWallet) {
        if (!query.requireStake) filteredPeers.push(match)
        continue
      }

      try {
        const agentId = await getAgentByPeerId(publicClient, identityState, match.peer.id)
        let stakeInfo: StakeInfo

          if (agentId > 0n) {
            stakeInfo = await fetchStakeInfo(publicClient, stakeState, agentId)
          } else {
            const canWorkResult = await canWork(publicClient, stakeState, peerWallet)
            stakeInfo = { stake: 0n, canWork: canWorkResult, effectiveScore: 0n, agentId: undefined }
          }


        if (query.requireStake && !stakeInfo.canWork) continue
        if (query.minStake && stakeInfo.stake < query.minStake) continue

        filteredPeers.push({
          ...match,
          peer: {
            ...match.peer,
            walletAddress: peerWallet,
            onChainReputation: {
              stake: stakeInfo.stake,
              canWork: stakeInfo.canWork,
              score: stakeInfo.effectiveScore,
            },
          },
        })
      } catch {
        if (!query.requireStake) filteredPeers.push(match)
      }
    }

    return filteredPeers
  }

  const request = createRequestMethod({ ref: baseAgent.ref, agentId: baseAgent.id })
  const send = createSendMethod({ ref: baseAgent.ref, agentId: baseAgent.id })

  const requestConsensus = async (options: ConsensusRequestOptions): Promise<ConsensusResult> => {
    const defaultConfig: MultiAgentConfig = {
      selectionStrategy: 'all',
      aggregationStrategy: 'consensus-threshold',
      consensusThreshold: 0.6,
      timeout: 60000,
      allowPartialResults: true,
    }

    const mergedConfig: MultiAgentConfig = { ...defaultConfig, ...options.config }

    if (effectiveEmbedFn && mergedConfig.semanticSimilarity?.enabled) {
      mergedConfig.semanticSimilarity = {
        ...mergedConfig.semanticSimilarity,
        localEmbedFn: effectiveEmbedFn,
      }
    }

    const capabilityQuery: CapabilityQuery = options.capabilityQuery ?? { requiredCapabilities: [] }
    const payload = { prompt: options.query }

    const orchestratorStateRef: StateRef<OrchestratorState> = {
      current: { ...initialOrchestratorState, loadStates: { ...initialOrchestratorState.loadStates } },
      version: 0,
    }

    const { result } = await executeOrchestration(
      baseAgent.ref,
      orchestratorStateRef,
      capabilityQuery,
      payload,
      mergedConfig,
      options.additionalResponses ?? []
    )

    const textResponse = extractTextFromResult(result.result)

    return {
      text: textResponse,
      consensus: { achieved: result.consensus.achieved, confidence: result.consensus.confidence },
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

    const discoveryConfig = { ...defaultDiscovery, ...queryConfig?.discovery }
    const capabilityQuery: CapabilityQuery = queryConfig?.discovery?.capabilityQuery ?? { requiredCapabilities: [] }

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
      const systemPrompt = queryConfig.systemPrompt ?? config.systemPrompt ?? defaultSystemPrompt

      try {
        let responseText = ''

        if (effectiveStreamGenerateFn) {
          const generator = effectiveStreamGenerateFn({ model: effectiveModel, system: systemPrompt, prompt })
          for await (const chunk of generator) {
            responseText += chunk.text
            if (queryConfig?.onStream) queryConfig.onStream({ ...chunk, peerId: baseAgent.id })
          }
        } else if (effectiveGenerateFn) {
          const result = await effectiveGenerateFn({ model: effectiveModel, system: systemPrompt, prompt })
          responseText = result.text
        }

        additionalResponses.push({
          peer: { id: baseAgent.id, addresses: baseAgent.addrs, capabilities: allCapabilities, lastSeen: Date.now() },
          matchScore: 1,
          response: { text: responseText },
          timestamp: Date.now(),
          latency: Date.now() - startTime,
          success: true,
        })
      } catch (error) {
        additionalResponses.push({
          peer: { id: baseAgent.id, addresses: baseAgent.addrs, capabilities: allCapabilities, lastSeen: Date.now() },
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

      return async (q: string, responses: AgentResponse[]): Promise<string> => {
        const responseTexts = responses.map((r) => {
          const text = typeof r.response === 'object' && r.response !== null && 'text' in r.response
            ? (r.response as { text: string }).text
            : String(r.response)
          return `[${r.peer.id}]: ${text}`
        }).join('\n\n')

        const synthesisPrompt = `Original question: "${q}"\n\nAgent responses:\n${responseTexts}\n\nProvide a unified consensus answer that incorporates the key insights from all perspectives. Be concise (2-3 sentences).`

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
          if (queryConfig?.onStream) queryConfig.onStream({ text: chunk.text, tokens: chunk.tokens, peerId: 'synthesis' })
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
        onStream: queryConfig?.onStream ? (chunk) => queryConfig.onStream!({ text: chunk.text, peerId: chunk.peerId }) : undefined,
        originalQuery: prompt,
        synthesizeFn: createSynthesizeFn(),
      },
    })
  }

  const stopInternal = async (): Promise<void> => {
    await stopNode(baseAgent.ref)
    if (modelState) await unloadModel(modelState)
    if (embeddingModelState) await unloadModel(embeddingModelState)
  }

  const stop = async (): Promise<void> => {
    activeAgents.delete(baseAgent.id)
    await stopInternal()
  }

  const walletAddress = walletState ? getAddress(walletState) : null
  let onChainAgentId: bigint | null = null

  const register = async (agentURI?: string): Promise<bigint> => {
    if (!walletState) {
      throw new Error('Wallet required for registration. Configure wallet in createAgent options.')
    }
    if (onChainAgentId !== null) {
      return onChainAgentId
    }

    const publicClient = getPublicClient(walletState, chainId)
    const walletClient = getWalletClient(walletState, chainId)

    const { agentId } = await registerAgent(
      publicClient,
      walletClient,
      identityState,
      agentURI ?? ''
    )

    await bindPeerId(publicClient, walletClient, identityState, agentId, baseAgent.id)

    onChainAgentId = agentId
    return agentId
  }

  const stakingMethods = createStakingMethods({
    walletState,
    reputationState,
    chainId,
    getAgentId: () => onChainAgentId,
  })

  agentInstance = {
    id: baseAgent.id,
    addrs: baseAgent.addrs,
    ref: baseAgent.ref,
    wallet: walletState,
    address: walletAddress,
    chainId,
    capabilities: allCapabilities,
    payments,
    fees,
    hasEmbedding: hasEmbeddingConfig || (hasLocalModel && config.localModel?.supportsEmbedding === true),
    protocolVersion: networkConfig.protocol.currentVersion,
    embed,
    findPeers,
    request,
    requestConsensus,
    send,
    stop,
    query,
    onChainAgentId: null,
    register,
    ...stakingMethods,
  }

  registerProcessCleanup()
  activeAgents.set(baseAgent.id, stopInternal)

  return agentInstance
}

function extractTextFromResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.content === 'string') return obj.content
    if (Array.isArray(obj.content) && obj.content[0]?.text) return String(obj.content[0].text)
    return JSON.stringify(result)
  }
  return String(result)
}

export * from './types'
export { extractPromptText, createLLMHandler, isAgentRequest } from './handlers'
export { createPaymentHelpers, createPaymentState, createFeeHelpers } from '../payments/payment-helpers'
