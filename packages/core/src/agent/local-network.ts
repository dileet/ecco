import { delay } from '../utils'
import { createAgent } from './index'
import type {
  Agent,
  LocalNetworkConfig,
  LocalNetwork,
  AgentEmbeddingConfig,
} from './types'

export async function createLocalNetwork(config: LocalNetworkConfig): Promise<LocalNetwork> {
  const agents: Agent[] = []
  let embeddingAgent: Agent | null = null
  let bootstrapAddrs: string[] = []

  if (config.embedding) {
    embeddingAgent = await createAgent({
      name: 'embedding-provider',
      capabilities: [
        { type: 'embedding', name: config.embedding.modelId, version: '1.0.0' },
      ],
      embedding: config.embedding,
      wallet: config.wallet,
    })

    bootstrapAddrs = embeddingAgent.addrs
    await delay(2000)
  }

  const agentPromises = config.agents.map(async (agentConfig, index) => {
    if (!config.embedding && index === 0) {
      const firstAgent = await createAgent({
        name: agentConfig.name,
        capabilities: agentConfig.capabilities,
        personality: agentConfig.personality,
        model: config.model,
        generateFn: config.generateFn,
        wallet: config.wallet,
      })

      bootstrapAddrs = firstAgent.addrs
      return firstAgent
    }

    await delay(index * 500)

    return createAgent({
      name: agentConfig.name,
      network: bootstrapAddrs,
      capabilities: agentConfig.capabilities,
      personality: agentConfig.personality,
      model: config.model,
      generateFn: config.generateFn,
      wallet: config.wallet,
    })
  })

  const createdAgents = await Promise.all(agentPromises)
  agents.push(...createdAgents)

  await delay(3000)

  const shutdown = async (): Promise<void> => {
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
    shutdown,
  }
}
