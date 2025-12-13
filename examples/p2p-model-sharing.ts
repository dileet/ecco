import {
  createAgent,
  requestGeneration,
  streamGeneration,
  delay,
  type Agent,
} from '@ecco/core'

async function main(): Promise<void> {
  console.log('=== P2P Model Sharing Example ===\n')
  console.log('This example shows distributed inference where:')
  console.log('- Provider agent hosts a local model and serves inference requests')
  console.log('- Consumer agent requests inference from the provider over P2P\n')

  const modelPath = process.env.MODEL_PATH
  if (!modelPath) {
    console.error('Error: MODEL_PATH environment variable is required')
    console.error('Set it to the path of a GGUF model file, e.g.:')
    console.error('  MODEL_PATH=./models/llama-2-7b.Q4_K_M.gguf bun run examples/p2p-model-sharing.ts')
    process.exit(1)
  }

  console.log(`Loading model from: ${modelPath}\n`)
  console.log('--- Starting Provider Agent ---\n')

  const providerAgent = await createAgent({
    name: 'model-provider',
    systemPrompt: 'You are a helpful assistant. Keep responses concise.',
    capabilities: [{ type: 'agent', name: 'inference-provider', version: '1.0.0' }],
    localModel: {
      modelPath,
      contextSize: 4096,
      modelName: 'llama-local',
      supportsEmbedding: false,
    },
  })

  console.log(`Provider agent started: ${providerAgent.id}`)
  console.log(`Provider capabilities:`)
  for (const cap of providerAgent.capabilities) {
    console.log(`  - ${cap.type}: ${cap.name}`)
  }
  console.log()

  await delay(1000)

  console.log('--- Starting Consumer Agent ---\n')

  const consumerAgent = await createAgent({
    name: 'inference-consumer',
    network: providerAgent.addrs,
    capabilities: [{ type: 'agent', name: 'consumer', version: '1.0.0' }],
  })

  console.log(`Consumer agent started: ${consumerAgent.id}`)
  console.log()

  await delay(2000)

  console.log('--- Discovering Model Providers ---\n')

  const peers = await consumerAgent.findPeers({
    requiredCapabilities: [{ type: 'model' }],
  })

  console.log(`Found ${peers.length} model provider(s):`)
  for (const match of peers) {
    console.log(`  - ${match.peer.id} (score: ${match.matchScore.toFixed(2)})`)
    for (const cap of match.matchedCapabilities) {
      if (cap.type === 'model') {
        const modelCap = cap as { modelName?: string; modelType?: string }
        console.log(`    Model: ${modelCap.modelName ?? 'unknown'} (${modelCap.modelType ?? 'unknown'})`)
      }
    }
  }
  console.log()

  if (peers.length === 0) {
    console.error('No model providers found!')
    await consumerAgent.stop()
    await providerAgent.stop()
    process.exit(1)
  }

  console.log('--- Requesting Generation via P2P ---\n')

  const prompt = 'Explain the concept of peer-to-peer networking in two sentences.'
  console.log(`Prompt: "${prompt}"\n`)
  console.log('Requesting inference from provider...\n')

  const response = await requestGeneration(consumerAgent.ref, prompt, {
    preferredPeers: [providerAgent.id],
    system: 'You are a helpful assistant. Keep responses concise.',
    timeout: 60000,
  })

  console.log('Response from provider:')
  console.log(response)
  console.log()

  console.log('--- Streaming Generation via P2P ---\n')

  const streamPrompt = 'What are three benefits of decentralized systems?'
  console.log(`Prompt: "${streamPrompt}"\n`)
  console.log('Streaming response:')

  let fullText = ''
  for await (const chunk of streamGeneration(consumerAgent.ref, streamPrompt, {
    preferredPeers: [providerAgent.id],
    system: 'You are a helpful assistant. Keep responses concise.',
    timeout: 60000,
  })) {
    process.stdout.write(chunk.text)
    fullText += chunk.text
  }

  console.log('\n')

  console.log('--- Shutting Down ---\n')
  console.log('\nExample complete!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
