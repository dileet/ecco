import { generateText, embed } from 'ai'
import { openai } from '@ai-sdk/openai'
import {
  createAgent,
  createLocalNetwork,
  delay,
  type Agent,
  type LocalNetwork,
  type GenerateFn,
  type EmbedFn,
  type NetworkQueryConfig,
} from '@ecco/core'

const EMBEDDING_MODEL = openai.embedding('text-embedding-3-small')
const MODEL = openai('gpt-4o-mini')

const generate: GenerateFn = async (options) => {
  const result = await generateText({
    model: options.model as Parameters<typeof generateText>[0]['model'],
    system: options.system,
    prompt: options.prompt,
  })

  return { text: result.text }
}

const embedFn: EmbedFn = async (texts) => {
  const results = await Promise.all(
    texts.map((text) => embed({ model: EMBEDDING_MODEL, value: text }))
  )
  return results.map((r) => Array.from(r.embedding))
}

async function main(): Promise<void> {
  console.log('=== Multi-Agent Consensus with Peer Embedding ===\n')

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is required')
    process.exit(1)
  }

  console.log('--- Creating Agents ---\n')

  const analyticalAgent = await createAgent({
    name: 'agent-analytical',
    personality: 'analytical and data-driven, focusing on facts and logic',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    model: MODEL,
    generateFn: generate,
  })
  console.log(`[${analyticalAgent.id.slice(0, 20)}...] Analytical agent started`)

  await delay(500)

  const creativeAgent = await createAgent({
    name: 'agent-creative',
    network: analyticalAgent.addrs,
    personality: 'creative and imaginative, offering unique perspectives',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    model: MODEL,
    generateFn: generate,
  })
  console.log(`[${creativeAgent.id.slice(0, 20)}...] Creative agent started`)

  await delay(500)

  const practicalAgent = await createAgent({
    name: 'agent-practical',
    network: analyticalAgent.addrs,
    personality: 'practical and straightforward, focusing on actionable advice',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    model: MODEL,
    generateFn: generate,
  })
  console.log(`[${practicalAgent.id.slice(0, 20)}...] Practical agent started`)

  console.log('\n--- Starting Local Network ---\n')

  const agents: Agent[] = [analyticalAgent, creativeAgent, practicalAgent]

  const network: LocalNetwork = await createLocalNetwork({
    agents,
    embedding: {
      embedFn,
      modelId: 'text-embedding-3-small',
    },
  })

  if (network.embedding) {
    console.log(`[embedding-provider] Started with peer ID: ${network.embedding.id}`)
  }

  console.log('\n--- Running Multi-Agent Queries ---\n')

  const queries = [
    'What is the most important thing to consider when starting a new software project?',
    'How can teams improve their collaboration and productivity?',
  ]

  for (const query of queries) {
    console.log(`\nQuery: "${query}"\n`)

    try {
      const result = await network.query(query, {
        semanticSimilarity: {
          enabled: true,
          method: 'peer-embedding',
          threshold: 0.75,
          requireExchange: false,
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

  const baseConfig: NetworkQueryConfig = {
    consensusThreshold: 0.6,
    timeout: 60000,
    allowPartialResults: true,
  }

  const strategies: Array<{ name: string; config: NetworkQueryConfig }> = [
    { name: 'Majority Vote', config: { ...baseConfig, aggregationStrategy: 'majority-vote' } },
    { name: 'Best Score', config: { ...baseConfig, aggregationStrategy: 'best-score' } },
    { name: 'Ensemble', config: { ...baseConfig, aggregationStrategy: 'ensemble' } },
  ]

  for (const { name, config } of strategies) {
    console.log(`Strategy: ${name}`)

    try {
      const result = await network.query('Give a one-sentence tip for writing clean code.', config)

      console.log(`  Answer: ${result.text}`)
      console.log(`  Confidence: ${(result.consensus.confidence * 100).toFixed(1)}%\n`)
    } catch (error) {
      console.error(`  ${name} failed:`, error)
    }
  }

  console.log('--- Shutting Down ---\n')

  await network.shutdown()
  console.log('[network] Stopped')

  console.log('\nExample complete!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
