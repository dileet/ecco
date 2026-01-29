import { zeroAddress } from 'viem'
import type { Message, CapabilityQuery, CapabilityMatch, EmbeddingCapability, ModelCapability } from '../types'
import {
  createAgent as createBaseAgent,
  stop as stopNode,
  broadcastCapabilities,
  findPeers as findPeersBase,
  findPeersWithPriority,
  getLibp2pPeerId,
  loadOrCreateNodeIdentity,
  resolvePeerIdentity,
} from '../networking'
import type { StateRef } from '../networking/types'
import { getAddress, getPublicClient, getWalletClient, type WalletState } from '../payments/wallet'
import { formatProtocolVersion } from '../networks'
import {
  createIdentityRegistryState,
  registerAgentWithMetadata,
  computePeerIdHash,
  setAgentURI,
  setAgentWallet,
  createSetAgentWalletTypedData,
} from '../identity'
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
import { submitExplicitFeedback, resolveWalletForPeer } from '../reputation/reputation-state'
import { normalizeRegistration, validateRegistration, createProviderRegistrationStorage } from '../identity/registration-storage'
import { formatGlobalId } from '../identity/global-id'
import { StorageProviderConfigSchema } from '../identity/provider-storage'
import { getERC8004Addresses } from '../networks'

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
  const providerConfig = config.reputation?.feedback?.storageProvider
  if (providerConfig) {
    const parsedProvider = StorageProviderConfigSchema.safeParse(providerConfig)
    if (!parsedProvider.success) {
      throw new Error('Invalid storage provider config')
    }
  }

  const identity = await loadOrCreateNodeIdentity({
    nodeId: config.name,
    capabilities: config.capabilities,
    discovery: networkConfig.discovery,
  })

  const ethereumPrivateKey = config.wallet?.privateKey
    ? (config.wallet.privateKey as `0x${string}`)
    : undefined

  const { walletState, reputationState, paymentState, payments } = await setupWallet({
    ethereumPrivateKey,
    walletEnabled: config.wallet?.enabled,
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

  const identityRegistryAddress: `0x${string}` =
    config.reputation?.identityRegistryAddress ??
    getERC8004Addresses(chainId)?.identityRegistry ??
    zeroAddress
  const identityState = createIdentityRegistryState(chainId, identityRegistryAddress)

  const findPeers = async (query?: FindPeersOptions): Promise<CapabilityMatch[]> => {
    const effectiveQuery: CapabilityQuery = query ?? { requiredCapabilities: [] }
    return findPeersBase(baseAgent.ref, effectiveQuery)
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

  const publishRegistration: Agent['publishRegistration'] = async (registration, options) => {
    if (!walletState) {
      throw new Error('Wallet required for registration. Configure wallet in createAgent options.')
    }
    const targetAgentId = options?.agentId ?? onChainAgentId
    if (targetAgentId === null) {
      throw new Error('Agent must be registered on-chain first. Call register() before publishing registration.')
    }
    if (targetAgentId > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('AgentId exceeds maximum safe integer')
    }

    const storageProvider = options?.storageProvider ?? config.reputation?.feedback?.storageProvider
    if (!storageProvider) {
      throw new Error('Storage provider required for registration publishing')
    }
    const storage = createProviderRegistrationStorage(storageProvider)
    const locator = {
      agentRegistry: formatGlobalId(chainId, identityRegistryAddress),
      agentId: Number(targetAgentId),
    }

    const parsedRegistration = validateRegistration(registration)
    const normalized = normalizeRegistration(parsedRegistration, locator)
    const uri = await storage.store(normalized)

    const publicClient = getPublicClient(walletState, chainId)
    const walletClient = getWalletClient(walletState, chainId)
    const txHash = await setAgentURI(publicClient, walletClient, identityState, targetAgentId, uri)

    return { agentId: targetAgentId, uri, txHash, registration: normalized }
  }

  const setAgentWalletForAgent: Agent['setAgentWallet'] = async (newWallet, deadline, signature, agentId) => {
    if (!walletState) {
      throw new Error('Wallet required for setAgentWallet. Configure wallet in createAgent options.')
    }
    const targetAgentId = agentId ?? onChainAgentId
    if (targetAgentId === null) {
      throw new Error('Agent must be registered on-chain first. Call register() before setting wallet.')
    }

    const publicClient = getPublicClient(walletState, chainId)
    const walletClient = getWalletClient(walletState, chainId)
    return setAgentWallet(publicClient, walletClient, identityState, targetAgentId, newWallet, deadline, signature)
  }

  const verifyAgentWallet: Agent['verifyAgentWallet'] = async (params) => {
    if (!walletState) {
      throw new Error('Wallet required for verifyAgentWallet. Configure wallet in createAgent options.')
    }
    const targetAgentId = params.agentId ?? onChainAgentId
    if (targetAgentId === null) {
      throw new Error('Agent must be registered on-chain first. Call register() before setting wallet.')
    }

    const publicClient = getPublicClient(walletState, chainId)
    const walletClient = getWalletClient(walletState, chainId)
    const account = walletClient.account
    if (!account) {
      throw new Error('Wallet client has no account')
    }

    const typedData = createSetAgentWalletTypedData({
      chainId,
      registryAddress: identityRegistryAddress,
      agentId: targetAgentId,
      newWallet: params.newWallet,
      deadline: params.deadline,
      name: params.name,
      version: params.version,
    })

    const signature = await walletClient.signTypedData({
      account,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    })

    const txHash = await setAgentWallet(
      publicClient,
      walletClient,
      identityState,
      targetAgentId,
      params.newWallet,
      params.deadline,
      signature
    )

    return { txHash, signature }
  }

  const ratePeer: Agent['ratePeer'] = async (peerId, value, options) => {
    if (!walletState || !reputationState) {
      throw new Error('Wallet required for rating. Configure wallet in createAgent options.')
    }
    return submitExplicitFeedback(reputationState, walletState, peerId, value, options)
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

    const peerId = getLibp2pPeerId(baseAgent.ref) ?? identity.peerId
    const peerIdHash = computePeerIdHash(peerId)
    const metadata = [
      { metadataKey: 'peerId', metadataValue: new Uint8Array(Buffer.from(peerId, 'utf8')) },
      { metadataKey: 'peerIdHash', metadataValue: new Uint8Array(Buffer.from(peerIdHash.slice(2), 'hex')) },
    ]

    const { agentId } = await registerAgentWithMetadata(
      publicClient,
      walletClient,
      identityState,
      agentURI ?? '',
      metadata
    )

    onChainAgentId = agentId
    return agentId
  }

  agentInstance = {
    id: baseAgent.id,
    addrs: baseAgent.addrs,
    ref: baseAgent.ref,
    wallet: walletState,
    address: walletAddress,
    chainId,
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
    onChainAgentId: null,
    register,
    publishRegistration,
    setAgentWallet: setAgentWalletForAgent,
    verifyAgentWallet,
    resolveWalletForPeer: async (peerId: string): Promise<`0x${string}` | null> => {
      if (!walletState || !reputationState) return null
      return resolveWalletForPeer(reputationState, walletState, peerId)
    },
    ratePeer,
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
export { createPaymentHelpers, createPaymentState } from '../payments/payment-helpers'
