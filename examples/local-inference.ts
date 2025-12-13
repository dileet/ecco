import {
  createAgent,
  delay,
  type Agent,
} from '@ecco/core'

async function main(): Promise<void> {
  console.log('=== Local Model Inference Example ===\n')

  const modelPath = process.env.MODEL_PATH
  if (!modelPath) {
    console.error('Error: MODEL_PATH environment variable is required')
    console.error('Set it to the path of a GGUF model file, e.g.:')
    console.error('  MODEL_PATH=./models/llama-2-7b.Q4_K_M.gguf bun run examples/local-inference.ts')
    process.exit(1)
  }

  console.log(`Loading model from: ${modelPath}\n`)

  const agent = await createAgent({
    name: 'local-inference-agent',
    systemPrompt: 'You are a helpful assistant. Keep responses concise.',
    capabilities: [{ type: 'agent', name: 'local-assistant', version: '1.0.0' }],
    localModel: {
      modelPath,
      contextSize: 4096,
      modelName: 'local-llm',
      supportsEmbedding: false,
    },
  })

  console.log(`Agent started: ${agent.id}`)
  console.log(`Capabilities: ${JSON.stringify(agent.capabilities, null, 2)}\n`)

  await delay(1000)

  const prompt = 'What is the capital of France? Answer in one sentence.'
  console.log(`Query: "${prompt}"\n`)
  console.log('Generating response...\n')

  const result = await agent.query(prompt, {
    includeSelf: true,
    aggregationStrategy: 'first-response',
  })

  console.log('Response:')
  console.log(result.text)

  console.log('Example complete!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
