import { createAgent, delay, type MessageContext, type PricingConfig } from '@ecco/core'

const ETH_SEPOLIA_CHAIN_ID = 11155111

const ESCROW_PRICING: PricingConfig = {
  type: 'escrow',
  chainId: ETH_SEPOLIA_CHAIN_ID,
  amount: '0.001',
  milestones: [
    { id: 'milestone-1', description: 'First deliverable', amount: '0.0005' },
    { id: 'milestone-2', description: 'Final deliverable', amount: '0.0005' },
  ],
}

async function main(): Promise<void> {
  console.log('=== Escrow Payments Example ===\n')
  console.log('This example demonstrates:')
  console.log('1. Service agent with escrow-based pricing')
  console.log('2. Client requests work, service releases milestones')
  console.log('3. Batched invoice for all milestones in a single payment\n')

  const rpcUrls: Record<number, string> = {}
  if (process.env.RPC_URL) {
    rpcUrls[ETH_SEPOLIA_CHAIN_ID] = process.env.RPC_URL
    console.log(`Using RPC: ${process.env.RPC_URL.replace(/\/v2\/[^/]+$/, '/v2/***')}\n`)
  } else {
    console.log('No RPC_URL provided - running in simulation mode\n')
  }

  const service = await createAgent({
    name: 'escrow-service',
    capabilities: [{ type: 'agent', name: 'code-review-service', version: '1.0.0' }],
    wallet: { rpcUrls },
    pricing: ESCROW_PRICING,
    handler: async (_message, ctx: MessageContext) => {
      console.log(`[service] Received work request, starting milestone-based work...`)

      console.log(`[service] Completing milestone 1...`)
      await delay(1000)
      await ctx.agent.payments.releaseMilestone(ctx, 'milestone-1', { sendInvoice: false })
      console.log(`[service] Milestone 1 released`)

      console.log(`[service] Completing milestone 2...`)
      await delay(1000)
      await ctx.agent.payments.releaseMilestone(ctx, 'milestone-2', { sendInvoice: false })
      console.log(`[service] Milestone 2 released`)

      await ctx.agent.payments.sendEscrowInvoice(ctx)
      console.log(`[service] Sent combined invoice for all milestones`)

      await ctx.reply({ status: 'complete', message: 'All milestones delivered!' })
    },
  })

  console.log(`[service] Started: ${service.id}`)
  console.log(`[service] Wallet: ${service.address ?? 'simulation mode'}`)

  const client = await createAgent({
    name: 'escrow-client',
    network: service.addrs,
    capabilities: [],
    wallet: { rpcUrls },
  })

  console.log(`[client] Started: ${client.id}`)
  console.log(`[client] Wallet: ${client.address ?? 'simulation mode'}\n`)

  await delay(3000)

  const peers = await client.findPeers({
    requiredCapabilities: [{ type: 'agent', name: 'code-review-service' }],
  })

  if (peers.length === 0) {
    console.error('Service not found!')
    await Promise.all([service.stop(), client.stop()])
    process.exit(1)
  }

  console.log(`[client] Found service, sending work request...`)
  const response = await client.request(peers[0].peer.id, 'Please review my code')
  console.log(`[client] Response:`, response.response)

  await delay(1000)

  const invoices = client.payments.getPendingInvoices()
  console.log(`\n[client] Received ${invoices.length} invoice(s)`)
  for (const inv of invoices) {
    console.log(`  - ${inv.amount} ${inv.token}`)
  }

  if (invoices.length > 0 && client.wallet) {
    console.log(`\n[client] Processing batch settlement...`)
    const results = await client.payments.settleAll()
    for (const result of results) {
      if (result.success) {
        console.log(`[client] Paid ${result.aggregatedInvoice.totalAmount} ETH`)
        console.log(`[client] TX: ${result.txHash}`)
        console.log(`[client] View: https://sepolia.etherscan.io/tx/${result.txHash}`)
      } else {
        console.log(`[client] Payment failed: ${result.error}`)
      }
    }
  } else if (invoices.length > 0) {
    console.log(`\n[client] Invoices queued for later settlement (no wallet)`)
  }

  console.log('\n=== Summary ===')
  console.log(`Service wallet: ${service.address ?? 'N/A'}`)
  console.log(`Client wallet: ${client.address ?? 'N/A'}`)

  console.log('\nDone!')
  process.exit(0)
}

main().catch(console.error)
