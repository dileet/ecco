import { createAgent, delay } from '@ecco/core'

async function main(): Promise<void> {
  console.log('=== Handshake Test ===\n')

  console.log('Creating agent 1...')
  const agent1 = await createAgent({
    name: 'agent-1',
    network: 'testnet',
    systemPrompt: 'Test agent 1',
    capabilities: [{ type: 'agent', name: 'test', version: '1.0.0' }],
  })
  console.log(`Agent 1 started: ${agent1.id}`)
  console.log(`Agent 1 addrs: ${agent1.addrs.join(', ')}`)

  await delay(2000)

  console.log('\nCreating agent 2 with bootstrap to agent 1...')
  const agent2 = await createAgent({
    name: 'agent-2',
    bootstrap: agent1.addrs,
    network: 'testnet',
    systemPrompt: 'Test agent 2',
    capabilities: [{ type: 'agent', name: 'test', version: '1.0.0' }],
  })
  console.log(`Agent 2 started: ${agent2.id}`)

  console.log('\nWaiting for peer discovery and handshake...')
  await delay(5000)

  console.log('\nFinding peers from agent 1...')
  const peers = await agent1.findPeers({ requiredCapabilities: [{ type: 'agent' }] })
  console.log(`Found ${peers.length} peers`)

  for (const peer of peers) {
    console.log(`  - ${peer.peer.id}`)
  }

  console.log('\nShutting down...')
  await agent1.stop()
  await agent2.stop()
  console.log('Done!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
