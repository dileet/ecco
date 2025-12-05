import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import {
  createLocalNetwork,
  createAgent,
  delay,
  type MultiAgentConfig,
  type LocalNetwork,
  type GenerateFn,
} from '@ecco/core'
import { setupEmbeddingProvider } from '@ecco/ai-sdk'

const EMBEDDING_MODEL = openai.embedding('text-embedding-3-small')

const generate: GenerateFn = async (options) => {
  const result = await generateText({
    model: options.model as Parameters<typeof generateText>[0]['model'],
    system: options.system,
    prompt: options.prompt,
  })
  return { text: result.text }
}

async function main(): Promise<void> {
  console.log('=== Multi-Agent Consensus with Peer Embedding ===\n')

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is required')
    process.exit(1)
  }

  console.log('--- Starting Local Network ---\n')

  const network: LocalNetwork = await createLocalNetwork({
    agents: [
      {
        name: 'agent-analytical',
        personality: 'analytical and data-driven, focusing on facts and logic',
        capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
      },
      {
        name: 'agent-creative',
        personality: 'creative and imaginative, offering unique perspectives',
        capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
      },
      {
        name: 'agent-practical',
        personality: 'practical and straightforward, focusing on actionable advice',
        capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
      },
    ],
    embedding: {
      model: EMBEDDING_MODEL,
      modelId: 'text-embedding-3-small',
    },
    model: openai('gpt-4o-mini'),
    generateFn: generate,
  })

  if (network.embedding) {
    setupEmbeddingProvider({
      nodeRef: network.embedding.ref,
      embeddingModel: EMBEDDING_MODEL,
      modelId: 'text-embedding-3-small',
      libp2pPeerId: network.embedding.id,
    })
    console.log(`[embedding-provider] Started with peer ID: ${network.embedding.id}`)
  }

  for (const agent of network.agents) {
    console.log(`[${agent.id.slice(0, 20)}...] Agent started`)
  }

  const coordinator = await createAgent({
    name: 'coordinator',
    network: network.embedding?.addrs ?? network.agents[0].addrs,
    capabilities: [{ type: 'coordinator', name: 'orchestrator', version: '1.0.0' }],
  })

  console.log(`[coordinator] Started with ID: ${coordinator.id}`)

  console.log('\n--- Waiting for Network Formation ---\n')
  await delay(3000)

  console.log('--- Network Status ---\n')
  const peers = await coordinator.findPeers()
  console.log(`Coordinator sees ${peers.length} peers:`)
  for (const match of peers) {
    const caps = match.peer.capabilities.map((c) => `${c.type}:${c.name}`).join(', ')
    console.log(`  - ${match.peer.id.slice(0, 20)}... (${caps})`)
  }

  console.log('\n--- Running Multi-Agent Queries ---\n')

  const queries = [
    'What is the most important thing to consider when starting a new software project?',
    'How can teams improve their collaboration and productivity?',
  ]

  for (const query of queries) {
    console.log(`\nQuery: "${query}"\n`)

    try {
      const result = await coordinator.requestConsensus({
        query,
        config: {
          selectionStrategy: 'all',
          aggregationStrategy: 'consensus-threshold',
          consensusThreshold: 0.6,
          timeout: 60000,
          allowPartialResults: true,
          semanticSimilarity: {
            enabled: true,
            method: 'peer-embedding',
            threshold: 0.75,
            requireExchange: false,
          },
        },
      })

      console.log(`Answer: ${result.text}\n`)
      console.log(
        `Confidence: ${(result.consensus.confidence * 100).toFixed(1)}% | Agents: ${result.metrics.successfulAgents}/${result.metrics.totalAgents} | Latency: ${result.metrics.averageLatency.toFixed(0)}ms`
      )
      console.log('-'.repeat(60))
    } catch (error) {
      console.error('Query failed:', error)
    }
  }

  console.log('\n--- Alternative Aggregation Strategies ---\n')

  const baseConfig: MultiAgentConfig = {
    selectionStrategy: 'all',
    aggregationStrategy: 'consensus-threshold',
    consensusThreshold: 0.6,
    timeout: 60000,
    allowPartialResults: true,
  }

  const strategies: Array<{ name: string; config: MultiAgentConfig }> = [
    { name: 'Majority Vote', config: { ...baseConfig, aggregationStrategy: 'majority-vote' } },
    { name: 'Best Score', config: { ...baseConfig, aggregationStrategy: 'best-score' } },
    { name: 'Ensemble', config: { ...baseConfig, aggregationStrategy: 'ensemble' } },
  ]

  for (const { name, config } of strategies) {
    console.log(`Strategy: ${name}`)

    try {
      const result = await coordinator.requestConsensus({
        query: 'Give a one-sentence tip for writing clean code.',
        config,
      })

      console.log(`  Answer: ${result.text}`)
      console.log(`  Confidence: ${(result.consensus.confidence * 100).toFixed(1)}%\n`)
    } catch (error) {
      console.error(`  ${name} failed:`, error)
    }
  }

  console.log('--- Shutting Down ---\n')

  await coordinator.stop()
  console.log('[coordinator] Stopped')

  await network.shutdown()
  console.log('[network] Stopped')

  console.log('\nExample complete!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
