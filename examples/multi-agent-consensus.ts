import { streamText, embed } from 'ai'
import { openai } from '@ai-sdk/openai'
import {
  createAgent,
  delay,
  type StreamGenerateFn,
  type EmbedFn,
  type QueryConfig,
} from '@ecco/core'

const EMBEDDING_MODEL = openai.embedding('text-embedding-3-small')
const MODEL = openai('gpt-4o-mini')

const streamGenerate: StreamGenerateFn = async function* (options) {
  const result = streamText({
    model: options.model as Parameters<typeof streamText>[0]['model'],
    system: options.system,
    prompt: options.prompt,
  })
  for await (const chunk of result.textStream) {
    yield { text: chunk, tokens: 1 }
  }
}

const embedFn: EmbedFn = async (texts) => {
  const results = await Promise.all(
    texts.map((text) => embed({ model: EMBEDDING_MODEL, value: text }))
  )
  return results.map((r) => Array.from(r.embedding))
}

async function main(): Promise<void> {
  console.log('=== Multi-Agent Consensus with Per-Agent Embedding ===\n')

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is required')
    process.exit(1)
  }

  console.log('--- Creating Agents ---\n')

  const analyticalAgent = await createAgent({
    name: 'agent-analytical',
    systemPrompt: 'You are an analytical and data-driven assistant, focusing on facts and logic. Keep responses concise (2-3 sentences).',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    model: MODEL,
    streamGenerateFn: streamGenerate,
    embedding: {
      embedFn,
      modelId: 'text-embedding-3-small',
    },
  })
  console.log(`[${analyticalAgent.id.slice(0, 20)}...] Analytical agent started (with embedding)`)

  await delay(500)

  const creativeAgent = await createAgent({
    name: 'agent-creative',
    network: analyticalAgent.addrs,
    systemPrompt: 'You are a creative and imaginative assistant, offering unique perspectives. Keep responses concise (2-3 sentences).',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    model: MODEL,
    streamGenerateFn: streamGenerate,
  })
  console.log(`[${creativeAgent.id.slice(0, 20)}...] Creative agent started`)

  await delay(500)

  const practicalAgent = await createAgent({
    name: 'agent-practical',
    network: analyticalAgent.addrs,
    systemPrompt: 'You are a practical and straightforward assistant, focusing on actionable advice. Keep responses concise (2-3 sentences).',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    model: MODEL,
    streamGenerateFn: streamGenerate,
  })
  console.log(`[${practicalAgent.id.slice(0, 20)}...] Practical agent started`)

  await delay(2000)

  console.log('\n--- Running Multi-Agent Queries ---\n')

  const queries = [
    'What is the most important thing to consider when starting a new software project?',
    'How can teams improve their collaboration and productivity?',
  ]

  for (const queryText of queries) {
    console.log(`\nQuery: "${queryText}"\n`)

    try {
      const agentBuffers = new Map<string, string>()
      let synthesisStarted = false

      const result = await analyticalAgent.query(queryText, {
        includeSelf: true,
        aggregationStrategy: 'synthesized-consensus',
        semanticSimilarity: {
          enabled: true,
          method: 'peer-embedding',
          threshold: 0.75,
        },
        onStream: (chunk) => {
          if (chunk.peerId === 'synthesis') {
            if (!synthesisStarted) {
              synthesisStarted = true
              for (const [peerId, text] of agentBuffers) {
                console.log(`[${peerId.slice(0, 16)}...]: ${text}`)
              }
              console.log('')
              process.stdout.write('[Synthesis]: ')
            }
            process.stdout.write(chunk.text)
          } else if (chunk.peerId) {
            const current = agentBuffers.get(chunk.peerId) ?? ''
            agentBuffers.set(chunk.peerId, current + chunk.text)
          }
        },
      })

      console.log('\n')
      console.log(
        `Confidence: ${(result.consensus.confidence * 100).toFixed(1)}% | Agents: ${result.metrics.successfulAgents}/${result.metrics.totalAgents} | Latency: ${result.metrics.averageLatency.toFixed(0)}ms`
      )
      console.log('-'.repeat(60))
    } catch (error) {
      console.error('Query failed:', error)
    }
  }

  console.log('\n--- Alternative Aggregation Strategies ---\n')

  const strategies: Array<{ name: string; config: QueryConfig }> = [
    {
      name: 'Majority Vote',
      config: {
        includeSelf: true,
        timeout: 60000,
        allowPartialResults: true,
        aggregationStrategy: 'majority-vote',
        consensusThreshold: 0.6,
        semanticSimilarity: {
          enabled: true,
          method: 'peer-embedding',
          threshold: 0.75,
        },
      },
    },
    {
      name: 'Best Score',
      config: {
        includeSelf: true,
        timeout: 60000,
        allowPartialResults: true,
        aggregationStrategy: 'best-score',
      },
    },
    {
      name: 'Ensemble',
      config: {
        includeSelf: true,
        timeout: 60000,
        allowPartialResults: true,
        aggregationStrategy: 'ensemble',
      },
    },
  ]

  for (const { name, config } of strategies) {
    console.log(`Strategy: ${name}`)

    try {
      const result = await analyticalAgent.query('Give a one-sentence tip for writing clean code.', config)

      console.log(`  Answer: ${result.text}`)
      console.log(`  Confidence: ${(result.consensus.confidence * 100).toFixed(1)}%\n`)
    } catch (error) {
      console.error(`  ${name} failed:`, error)
    }
  }

  console.log('\nExample complete!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
