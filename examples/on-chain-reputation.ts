import { formatEther, parseEther } from 'viem'
import { createAgent, delay } from '@ecco/core'

async function demonstrateSimplifiedFlow(): Promise<void> {
  console.log('=== Simplified On-Chain Reputation Flow ===\n')

  console.log('--- Step 1: Create Agent with Auto-Configured Wallet ---\n')

  const agent = await createAgent({
    name: 'staked-agent',
    network: 'testnet',
    systemPrompt: 'You are a staked agent on the ECCO network.',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
  })

  console.log(`Agent ID: ${agent.id}`)
  console.log(`Agent Wallet: ${agent.address}`)
  console.log(`Chain ID: ${agent.chainId} (auto-detected from network)`)
  console.log(`Wallet persisted at: ~/.ecco/identity/staked-agent.json`)

  console.log('\n--- Step 2: Register Agent On-Chain ---\n')

  try {
    console.log('Registering agent on-chain...')
    const onChainAgentId = await agent.register('ipfs://agent-metadata')
    console.log(`On-Chain Agent ID: ${onChainAgentId}`)
    console.log('Peer ID bound to on-chain identity')
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    if (errorMsg.includes('not supported') || errorMsg.includes('zero address')) {
      console.log('Contracts not yet deployed to this chain.')
    } else {
      console.error('Failed to register:', errorMsg)
    }
  }

  console.log('\n--- Step 3: Check Current Stake ---\n')

  try {
    const stakeInfo = await agent.getStakeInfo()
    console.log(`Current Stake: ${formatEther(stakeInfo.stake)} ECCO`)
    console.log(`Can Work: ${stakeInfo.canWork}`)
    console.log(`Effective Score: ${stakeInfo.effectiveScore}`)
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    if (errorMsg.includes('not supported') || errorMsg.includes('not registered')) {
      console.log('Agent not registered or contracts not deployed.')
    } else {
      console.error('Failed to fetch stake info:', errorMsg)
    }
  }

  console.log('\n--- Step 4: Stake ECCO Tokens ---\n')

  try {
    console.log('Staking 100 ECCO tokens...')
    const txHash = await agent.stake(parseEther('100'))
    console.log('Staked! TX:', txHash)

    console.log('\nWaiting for confirmation...')
    await delay(3000)

    console.log('Checking updated stake info...')
    const updatedStakeInfo = await agent.getStakeInfo()
    console.log(`New Stake: ${formatEther(updatedStakeInfo.stake)} ECCO`)
    console.log(`Can Work: ${updatedStakeInfo.canWork}`)
    console.log(`Effective Score: ${updatedStakeInfo.effectiveScore}`)
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error('Failed to stake:', errorMsg)
  }

  await agent.stop()
  console.log('\n--- Demo Complete ---\n')
}

async function demonstrateDiscoveryWithStaking(): Promise<void> {
  console.log('=== Discovery with Stake Requirements ===\n')

  console.log('--- Creating Two Agents ---\n')

  const orchestrator = await createAgent({
    name: 'orchestrator',
    network: 'testnet',
    systemPrompt: 'You orchestrate queries.',
    capabilities: [{ type: 'agent', name: 'orchestrator', version: '1.0.0' }],
  })
  console.log(`Orchestrator: ${orchestrator.id.slice(0, 30)}...`)
  console.log(`  Wallet: ${orchestrator.address}`)
  console.log(`  Chain: ${orchestrator.chainId}`)

  await delay(500)

  const worker = await createAgent({
    name: 'worker',
    network: 'testnet',
    bootstrap: orchestrator.addrs,
    systemPrompt: 'You are a helpful assistant.',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
  })
  console.log(`Worker: ${worker.id.slice(0, 30)}...`)
  console.log(`  Wallet: ${worker.address}`)
  console.log(`  Chain: ${worker.chainId}`)

  await delay(2000)

  console.log('\n--- Finding Peers with Stake Requirements ---\n')

  console.log('Find all peers (no stake requirement):')
  const allPeers = await orchestrator.findPeers({
    requiredCapabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
  })
  console.log(`  Found ${allPeers.length} peers`)

  console.log('\nFind only staked peers:')
  console.log('```typescript')
  console.log('const stakedPeers = await orchestrator.findPeers({')
  console.log('  requiredCapabilities: [...],')
  console.log('  requireStake: true,')
  console.log('})')
  console.log('```')

  console.log('\nFind peers with minimum stake:')
  console.log('```typescript')
  console.log('const highStakePeers = await orchestrator.findPeers({')
  console.log('  requiredCapabilities: [...],')
  console.log('  minStake: parseEther("100"),')
  console.log('})')
  console.log('```')

  console.log('\n--- Resolve Peer Wallets ---\n')

  console.log('To get the wallet address of a discovered peer:')
  console.log('```typescript')
  console.log('const peerWallet = await orchestrator.resolveWalletForPeer(peerId)')
  console.log('```')

  await orchestrator.stop()
  await worker.stop()
  console.log('\n--- Discovery Demo Complete ---\n')
}

async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════╗')
  console.log('║     ECCO Simplified On-Chain Reputation Demo               ║')
  console.log('╚════════════════════════════════════════════════════════════╝\n')

  const isDiscovery = process.argv.includes('--discovery')

  if (isDiscovery) {
    await demonstrateDiscoveryWithStaking()
  } else {
    await demonstrateSimplifiedFlow()
    console.log('─'.repeat(60))
    await demonstrateDiscoveryWithStaking()
  }

  console.log('╔════════════════════════════════════════════════════════════╗')
  console.log('║                     Summary                                ║')
  console.log('╚════════════════════════════════════════════════════════════╝\n')

  console.log('The simplified API provides:\n')

  console.log('1. AUTO-CONFIGURED WALLET')
  console.log('   - Just pass `wallet: {}` to createAgent')
  console.log('   - Default RPC URLs for Monad Testnet and Monad Mainnet')
  console.log('   - Chain ID auto-detected from network config\n')

  console.log('2. ON-CHAIN REGISTRATION')
  console.log('   - `agent.register(agentURI)` - register agent and bind peer ID')
  console.log('   - Returns on-chain agentId for staking operations')
  console.log('   - Only needs to be called once per agent\n')

  console.log('3. SIMPLE STAKING')
  console.log('   - `agent.stake(amount)` - stake tokens (requires registration)')
  console.log('   - `agent.unstake(amount)` - request unstaking')
  console.log('   - `agent.getStakeInfo()` - check your stake status\n')

  console.log('4. STAKE-AWARE PEER DISCOVERY')
  console.log('   - `findPeers({ requireStake: true })` - only staked peers')
  console.log('   - `findPeers({ minStake: parseEther("100") })` - minimum stake')
  console.log('   - `resolveWalletForPeer(peerId)` - get peer wallet address\n')

  console.log('5. BACKWARD COMPATIBLE')
  console.log('   - Low-level functions still available for advanced use')
  console.log('   - `computePeerIdHash()`, `stake()`, `getWalletForPeerId()`')
  console.log('   - `createReputationState()` for manual state management\n')

  console.log('Run modes:')
  console.log('  bun run on-chain-reputation.ts              # Full demo')
  console.log('  bun run on-chain-reputation.ts --discovery  # Discovery only\n')

  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
