import {
  createAgent,
  createLocalModel,
  createLocalStreamGenerateFn,
  delay,
  type QueryConfig,
  type LocalModelState,
} from '@ecco/core'

async function main(): Promise<void> {
  console.log('=== Multi-Agent Consensus with Local Inference ===\n')
  console.log('This example shows distributed consensus where:')
  console.log('- Multiple agents each host the same local model')
  console.log('- Each agent has a different persona/perspective')
  console.log('- Responses are aggregated using semantic similarity\n')

  const modelPath = process.env.MODEL_PATH
  if (!modelPath) {
    console.error('Error: MODEL_PATH environment variable is required')
    console.error('Set it to the path of a GGUF model file, e.g.:')
    console.error('  MODEL_PATH=./models/llama-2-7b.Q4_K_M.gguf bun run examples/local-consensus.ts')
    process.exit(1)
  }

  const embeddingModelPath = process.env.EMBEDDING_MODEL_PATH
  const useLocalEmbeddings = !!embeddingModelPath

  console.log(`Model: ${modelPath}`)
  if (useLocalEmbeddings) {
    console.log(`Embedding model: ${embeddingModelPath}`)
  } else {
    console.log('Embedding: text-overlap (set EMBEDDING_MODEL_PATH for local embeddings)')
  }
  console.log()

  console.log('--- Creating Agents ---\n')

  const model1 = await createLocalModel({
    modelPath,
    contextSize: 4096,
  })

  let embeddingModel: LocalModelState | null = null
  if (useLocalEmbeddings) {
    embeddingModel = await createLocalModel({
      modelPath: embeddingModelPath,
      contextSize: 2048,
      embedding: true,
    })
  }

  const analyticalAgent = await createAgent({
    name: 'agent-analytical',
    systemPrompt: 'You are an analytical and data-driven assistant, focusing on facts and logic. Keep responses concise (2-3 sentences).',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    model: model1,
    streamGenerateFn: createLocalStreamGenerateFn(model1),
    embedding: embeddingModel ?? undefined,
  })
  console.log(`[analytical] Started: ${analyticalAgent.id.slice(0, 20)}...`)

  await delay(500)

  const model2 = await createLocalModel({
    modelPath,
    contextSize: 4096,
  })

  const creativeAgent = await createAgent({
    name: 'agent-creative',
    network: analyticalAgent.addrs,
    systemPrompt: 'You are a creative and imaginative assistant, offering unique perspectives and thinking outside the box. Keep responses concise (2-3 sentences).',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    model: model2,
    streamGenerateFn: createLocalStreamGenerateFn(model2),
  })
  console.log(`[creative] Started: ${creativeAgent.id.slice(0, 20)}...`)

  await delay(500)

  const model3 = await createLocalModel({
    modelPath,
    contextSize: 4096,
  })

  const practicalAgent = await createAgent({
    name: 'agent-practical',
    network: analyticalAgent.addrs,
    systemPrompt: 'You are a practical and straightforward assistant, focusing on actionable real-world advice. Keep responses concise (2-3 sentences).',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    model: model3,
    streamGenerateFn: createLocalStreamGenerateFn(model3),
  })
  console.log(`[practical] Started: ${practicalAgent.id.slice(0, 20)}...`)

  console.log('Waiting for peer discovery...')
  await delay(3000)

  const peers = await analyticalAgent.findPeers()
  console.log(`Discovered ${peers.length} peers`)

  if (peers.length < 2) {
    console.log('Waiting for more peers...')
    await delay(2000)
  }

  console.log('\n--- Running Multi-Agent Queries ---\n')

  const queries = [
    'What is the most important thing to consider when starting a new software project?',
    'How can teams improve their collaboration and productivity?',
  ]

  const peerNames: Record<string, string> = {
    [analyticalAgent.id]: 'analytical',
    [creativeAgent.id]: 'creative',
    [practicalAgent.id]: 'practical',
  }

  for (const queryText of queries) {
    console.log(`Query: "${queryText}"\n`)

    try {
      const peerBuffers: Record<string, string> = {}

      const result = await analyticalAgent.query(queryText, {
        includeSelf: true,
        aggregationStrategy: 'synthesized-consensus',
        semanticSimilarity: {
          enabled: true,
          method: useLocalEmbeddings ? 'local-embedding' : 'text-overlap',
          threshold: 0.6,
        },
        onStream: (chunk) => {
          if (!chunk.peerId) return
          if (!peerBuffers[chunk.peerId]) {
            peerBuffers[chunk.peerId] = ''
          }
          peerBuffers[chunk.peerId] += chunk.text
        },
      })

      for (const [peerId, text] of Object.entries(peerBuffers)) {
        const name = peerNames[peerId] ?? peerId.slice(-8)
        console.log(`[${name}] ${text}\n`)
      }

      console.log(`[consensus] ${result.text}\n`)

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
        timeout: 120000,
        allowPartialResults: true,
        aggregationStrategy: 'majority-vote',
        consensusThreshold: 0.6,
        semanticSimilarity: {
          enabled: true,
          method: useLocalEmbeddings ? 'local-embedding' : 'text-overlap',
          threshold: 0.6,
        },
      },
    },
    {
      name: 'Best Score',
      config: {
        includeSelf: true,
        timeout: 120000,
        allowPartialResults: true,
        aggregationStrategy: 'best-score',
      },
    },
    {
      name: 'Ensemble',
      config: {
        includeSelf: true,
        timeout: 120000,
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

  console.log('--- Shutting Down ---\n')


  console.log('\nExample complete!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
