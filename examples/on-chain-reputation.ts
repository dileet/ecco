import {
  createAgent,
  delay,
  getPublicClient,
  createReputationRegistryState,
  resolveRegistryAddresses,
  getSummary,
  readAllFeedback,
  HexAddressSchema,
} from '@ecco/core'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing ${name}`)
  }
  return value
}

async function demonstrateEndToEndFlow(): Promise<void> {
  console.log('=== ERC-8004 End-to-End Flow ===\n')

  const uploadUrl = requireEnv('ECCO_STORAGE_UPLOAD_URL')
  const responseField = requireEnv('ECCO_STORAGE_RESPONSE_FIELD')
  const authHeader = process.env.ECCO_STORAGE_AUTH
  const uriPrefix = process.env.ECCO_STORAGE_URI_PREFIX
  const gateway = process.env.ECCO_STORAGE_GATEWAY
  const bodyField = process.env.ECCO_STORAGE_BODY_FIELD

  const storageProvider = {
    uploadUrl,
    responseField,
    uriPrefix,
    ...(authHeader ? { headers: { Authorization: authHeader } } : {}),
    ...(gateway ? { gateway } : {}),
    ...(bodyField ? { bodyField } : {}),
  }

  console.log('--- Step 1: Create Agents ---\n')

  const agentA = await createAgent({
    name: 'agent-a',
    network: 'testnet',
    systemPrompt: 'You are agent A.',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    reputation: {
      feedback: {
        storageProvider,
      },
    },
  })

  await delay(500)

  const agentB = await createAgent({
    name: 'agent-b',
    network: 'testnet',
    bootstrap: agentA.addrs,
    systemPrompt: 'You are agent B.',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    reputation: {
      feedback: {
        storageProvider,
      },
    },
  })

  const agentAAddress = HexAddressSchema.parse(agentA.address)
  const agentBAddress = HexAddressSchema.parse(agentB.address)

  console.log('Agent A ID:', agentA.id)
  console.log('Agent A Wallet:', agentAAddress)
  console.log('Agent B ID:', agentB.id)
  console.log('Agent B Wallet:', agentBAddress)

  console.log('\n--- Step 2: Register Agents On-Chain ---\n')

  const agentAId = await agentA.register()
  const agentBId = await agentB.register()

  console.log('Agent A On-Chain ID:', agentAId)
  console.log('Agent B On-Chain ID:', agentBId)

  console.log('\n--- Step 3: Publish Registration Files ---\n')

  await agentA.publishRegistration({
    name: 'agent-a',
    description: 'Example agent registration',
    image: 'ipfs://cid',
    services: [{ type: 'web', name: 'web', endpoint: 'https://agent-a.example.com' }],
    supportedTrust: ['reputation'],
  })

  await agentB.publishRegistration({
    name: 'agent-b',
    description: 'Example agent registration',
    image: 'ipfs://cid',
    services: [{ type: 'web', name: 'web', endpoint: 'https://agent-b.example.com' }],
    supportedTrust: ['reputation'],
  })

  console.log('Published registration files')

  console.log('\n--- Step 4: Verify Agent Wallet (Optional) ---\n')

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
  await agentA.verifyAgentWallet({
    newWallet: agentAAddress,
    deadline,
  })

  console.log('Verified agent wallet')

  console.log('\n--- Step 5: Submit Feedback ---\n')

  await agentA.ratePeer(agentB.id, 92, {
    tag1: 'starred',
    valueDecimals: 0,
    endpoint: 'https://agent-b.example.com',
  })

  console.log('Submitted feedback')

  console.log('\n--- Step 6: Aggregate Trust ---\n')

  const addresses = resolveRegistryAddresses(agentA.chainId)
  if (
    addresses.identityRegistryAddress === '0x0000000000000000000000000000000000000000' ||
    addresses.reputationRegistryAddress === '0x0000000000000000000000000000000000000000'
  ) {
    throw new Error('ERC-8004 addresses not configured for this chain')
  }

  const agentAWallet = agentA.wallet
  if (!agentAWallet) {
    throw new Error('Agent A wallet not configured')
  }
  const publicClient = getPublicClient(agentAWallet, agentA.chainId)
  const repState = createReputationRegistryState(
    agentA.chainId,
    addresses.reputationRegistryAddress,
    addresses.identityRegistryAddress
  )

  const summary = await getSummary(publicClient, repState, agentBId, [agentAAddress], 'starred', '')
  const feedback = await readAllFeedback(publicClient, repState, agentBId, [agentAAddress], '', '', false)

  console.log('Feedback summary:', summary)
  console.log('Raw feedback:', feedback)

  await agentA.stop()
  await agentB.stop()

  console.log('\n--- Demo Complete ---\n')
}

async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════╗')
  console.log('║     ECCO ERC-8004 End-to-End Reputation Demo               ║')
  console.log('╚════════════════════════════════════════════════════════════╝\n')

  await demonstrateEndToEndFlow()

  console.log('╔════════════════════════════════════════════════════════════╗')
  console.log('║                     Summary                                ║')
  console.log('╚════════════════════════════════════════════════════════════╝\n')

  console.log('This demo shows the ERC-8004 flow:')
  console.log('1. Register agents on-chain')
  console.log('2. Publish registration files and set agentURI')
  console.log('3. Verify agent wallet with EIP-712')
  console.log('4. Submit feedback to the Reputation Registry')
  console.log('5. Aggregate trust via getSummary/readAllFeedback\n')

  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
