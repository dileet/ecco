import { delay } from '../utils'
import { createAgent } from './index'
import { getLibp2pPeerId } from '../node'
import { setupEmbeddingProvider } from '../services/embedding'
import type {
  Agent,
  LocalNetworkConfig,
  LocalNetwork,
  NetworkQueryConfig,
  ConsensusResult,
} from './types'
import type { MultiAgentConfig } from '../orchestrator/types'

export async function createLocalNetwork(config: LocalNetworkConfig): Promise<LocalNetwork> {
  const agents = config.agents
  let embeddingAgent: Agent | null = null

  const agentBootstrapAddrs = agents[0]?.addrs ?? []

  if (config.embedding) {
    embeddingAgent = await createAgent({
      name: 'embedding-provider',
      network: agentBootstrapAddrs,
      capabilities: [
        { type: 'embedding', name: config.embedding.modelId, version: '1.0.0' },
      ],
      wallet: config.wallet,
    })

    setupEmbeddingProvider({
      nodeRef: embeddingAgent.ref,
      embedFn: config.embedding.embedFn,
      modelId: config.embedding.modelId,
      libp2pPeerId: getLibp2pPeerId(embeddingAgent.ref),
    })

    await delay(2000)
  }

  await delay(3000)

  const coordinatorAgent = await createAgent({
    name: '__ecco_internal_coordinator__',
    network: agentBootstrapAddrs,
    capabilities: [{ type: 'coordinator', name: 'internal-orchestrator', version: '1.0.0' }],
  })

  await delay(2000)

  const agentPeerIds = agents.map((a) => a.id)

  const query = async (prompt: string, queryConfig?: NetworkQueryConfig): Promise<ConsensusResult> => {
    const defaultConfig: MultiAgentConfig = {
      selectionStrategy: 'all',
      aggregationStrategy: 'consensus-threshold',
      consensusThreshold: 0.6,
      timeout: 60000,
      allowPartialResults: true,
    }

    const mergedConfig: MultiAgentConfig = {
      ...defaultConfig,
      ...queryConfig,
    }

    return coordinatorAgent.requestConsensus({
      query: prompt,
      config: mergedConfig,
      capabilityQuery: {
        requiredCapabilities: [],
        preferredPeers: agentPeerIds,
      },
    })
  }

  const shutdown = async (): Promise<void> => {
    await coordinatorAgent.stop()
    for (const agent of agents) {
      await agent.stop()
    }
    if (embeddingAgent) {
      await embeddingAgent.stop()
    }
  }

  return {
    agents,
    embedding: embeddingAgent,
    query,
    shutdown,
  }
}
