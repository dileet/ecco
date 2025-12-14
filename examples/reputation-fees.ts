import { streamText, embed } from 'ai'
import { openai } from '@ai-sdk/openai'
import {
  createAgent,
  delay,
  type StreamGenerateFn,
  type EmbedFn,
  createReputationState,
  recordLocalSuccess,
  recordLocalFailure,
  getEffectiveScore,
  createBloomFilterState,
  buildLocalFilters,
  findCandidates,
  createLatencyZoneState,
  updatePeerZone,
  getZoneStats,
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
  console.log('=== Reputation-Based Peer Selection & Fee Collection ===\n')

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is required')
    process.exit(1)
  }

  console.log('--- Part 1: Local Reputation Tracking ---\n')

  const reputationState = createReputationState({ chainId: 1 })
  const peerIds = ['peer-1', 'peer-2', 'peer-3']

  recordLocalSuccess(reputationState, peerIds[0])
  recordLocalSuccess(reputationState, peerIds[0])
  recordLocalSuccess(reputationState, peerIds[1])
  recordLocalFailure(reputationState, peerIds[1])
  recordLocalSuccess(reputationState, peerIds[2])
  recordLocalSuccess(reputationState, peerIds[2])
  recordLocalSuccess(reputationState, peerIds[2])

  console.log('Peer reputation scores (local):')
  for (const peerId of peerIds) {
    const rep = reputationState.peers.get(peerId)
    const score = rep ? getEffectiveScore(rep) : 0
    console.log(`  ${peerId}: score=${score.toFixed(1)}, successes=${rep?.successfulJobs ?? 0}, failures=${rep?.failedJobs ?? 0}`)
  }

  console.log('\n--- Part 2: Bloom Filter Fast Lookup ---\n')

  let bloomState = createBloomFilterState()

  const mockCapabilities = ['assistant', 'code-review', 'translation']

  bloomState = buildLocalFilters(bloomState, reputationState, mockCapabilities, 'self')

  console.log('Bloom filter tiers populated:')
  console.log(`  Elite tier (≥90): ${bloomState.localFilters.get('assistant:elite')?.peerCount ?? 0} peers`)
  console.log(`  Good tier (≥70): ${bloomState.localFilters.get('assistant:good')?.peerCount ?? 0} peers`)
  console.log(`  Acceptable tier (≥50): ${bloomState.localFilters.get('assistant:acceptable')?.peerCount ?? 0} peers`)

  const candidates = findCandidates(bloomState, 'assistant', peerIds, 'elite')
  console.log(`\nCandidates for 'assistant' capability (preferring elite):`)
  for (const c of candidates) {
    console.log(`  ${c.peerId}: tier=${c.tier}`)
  }

  console.log('\n--- Part 3: Latency Zone Classification ---\n')

  let zoneState = createLatencyZoneState()

  const latencyMeasurements: Record<string, number> = {
    'peer-local': 30,
    'peer-regional': 120,
    'peer-continental': 250,
    'peer-global': 450,
  }

  for (const [peerId, latency] of Object.entries(latencyMeasurements)) {
    zoneState = updatePeerZone(zoneState, peerId, latency)
  }

  console.log('Peer latency zones:')
  for (const [peerId, latency] of Object.entries(latencyMeasurements)) {
    const zone = zoneState.peerZones.get(peerId) ?? 'unknown'
    console.log(`  ${peerId}: ${latency}ms -> ${zone} zone`)
  }

  const stats = getZoneStats(zoneState, 'local')
  console.log(`\nLocal zone stats: ${stats?.peerCount ?? 0} peers, avg latency ${stats?.avgLatency.toFixed(0) ?? 0}ms`)

  console.log('\n--- Part 4: Agent with Fee Collection ---\n')

  console.log('Creating agents with wallet support...')

  const orchestratorAgent = await createAgent({
    name: 'agent-orchestrator',
    systemPrompt: 'You orchestrate multi-agent queries and manage fee collection.',
    capabilities: [{ type: 'agent', name: 'orchestrator', version: '1.0.0' }],
    model: MODEL,
    streamGenerateFn: streamGenerate,
    embedding: {
      embedFn,
      modelId: 'text-embedding-3-small',
    },
  })
  console.log(`[${orchestratorAgent.id.slice(0, 20)}...] Orchestrator agent started`)

  await delay(500)

  const workerAgent = await createAgent({
    name: 'agent-worker',
    network: orchestratorAgent.addrs,
    systemPrompt: 'You are a helpful assistant worker agent.',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    model: MODEL,
    streamGenerateFn: streamGenerate,
  })
  console.log(`[${workerAgent.id.slice(0, 20)}...] Worker agent started`)

  if (orchestratorAgent.fees) {
    console.log('\nFee collection available on orchestrator agent')
    console.log('  - calculateFee(chainId, amount): Calculate fee for an amount')
    console.log('  - payWithFee(chainId, recipient, amount): Pay with automatic fee deduction')
    console.log('  - claimRewards(chainId): Claim staking rewards from fee pool')
    console.log('  - getPendingRewards(chainId): Check pending rewards')
  } else {
    console.log('\nNo wallet configured - fee collection disabled')
    console.log('To enable, set wallet.privateKey in agent config')
  }

  await delay(2000)

  console.log('\n--- Part 5: Running Query with Reputation-Aware Selection ---\n')

  const queryText = 'What are the key principles of building reliable distributed systems?'
  console.log(`Query: "${queryText}"\n`)

  try {
    const result = await orchestratorAgent.query(queryText, {
      includeSelf: true,
      aggregationStrategy: 'synthesized-consensus',
      semanticSimilarity: {
        enabled: true,
        method: 'peer-embedding',
        threshold: 0.7,
      },
      onStream: (chunk) => {
        if (chunk.peerId === 'synthesis') {
          process.stdout.write(chunk.text)
        }
      },
    })

    console.log('\n')
    console.log(`Consensus achieved: ${result.consensus.achieved}`)
    console.log(`Confidence: ${(result.consensus.confidence * 100).toFixed(1)}%`)
    console.log(`Agents: ${result.metrics.successfulAgents}/${result.metrics.totalAgents}`)
    console.log(`Average latency: ${result.metrics.averageLatency.toFixed(0)}ms`)
  } catch (error) {
    console.error('Query failed:', error)
  }

  console.log('\n--- Summary ---\n')
  console.log('This example demonstrated:')
  console.log('  1. Local reputation tracking with success/failure recording')
  console.log('  2. Bloom filter tiers for O(1) peer capability lookup')
  console.log('  3. Latency zone classification (local/regional/continental/global)')
  console.log('  4. Agent creation with fee collection helpers')
  console.log('  5. Multi-agent query with reputation-aware peer selection')
  console.log('\nThe combined scoring system prioritizes:')
  console.log('  - ECCO stakers (10% priority boost)')
  console.log('  - High reputation peers (bloom filter elite tier)')
  console.log('  - Low latency peers (local zone preferred)')
  console.log('  - Capability match score')

  console.log('\nExample complete!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
