import { createAgent, delay, type MessageContext } from '@ecco/core'

const ETH_SEPOLIA_CHAIN_ID = 11155111

async function main(): Promise<void> {
  console.log('=== Swarm Payments Example ===\n')
  console.log('This example demonstrates:')
  console.log('1. Client distributes a job across multiple workers')
  console.log('2. Each worker contributes to the job')
  console.log('3. Client creates a swarm split based on contributions')
  console.log('4. Payments are distributed proportionally to each worker\n')

  const rpcUrls: Record<number, string> = {}
  if (process.env.RPC_URL) {
    rpcUrls[ETH_SEPOLIA_CHAIN_ID] = process.env.RPC_URL
    console.log(`Using RPC: ${process.env.RPC_URL.replace(/\/v2\/[^/]+$/, '/v2/***')}\n`)
  } else {
    console.log('No RPC_URL provided - running in simulation mode\n')
  }

  const client = await createAgent({
    name: 'swarm-client',
    capabilities: [],
    wallet: process.env.CLIENT_PRIVATE_KEY
      ? { privateKey: process.env.CLIENT_PRIVATE_KEY, rpcUrls }
      : undefined,
  })

  console.log(`[client] Started: ${client.id}`)
  console.log(`[client] Wallet: ${client.address ?? 'simulation mode'}`)

  const workerConfigs = [
    { name: 'worker1', task: 'data-processing', contribution: 40, key: process.env.WORKER1_PRIVATE_KEY },
    { name: 'worker2', task: 'image-rendering', contribution: 35, key: process.env.WORKER2_PRIVATE_KEY },
    { name: 'worker3', task: 'analysis', contribution: 25, key: process.env.WORKER3_PRIVATE_KEY },
  ]

  const workers = await Promise.all(
    workerConfigs.map(async (cfg) => {
      const worker = await createAgent({
        name: cfg.name,
        network: client.addrs,
        capabilities: [{ type: 'agent', name: 'distributed-worker', version: '1.0.0', metadata: { task: cfg.task } }],
        wallet: cfg.key ? { privateKey: cfg.key, rpcUrls } : undefined,
        handler: async (_message, ctx: MessageContext) => {
          console.log(`[${cfg.name}] Received job, completing task: ${cfg.task}`)
          await delay(1000) 
          await ctx.reply({ task: cfg.task, contribution: cfg.contribution, completed: true })
          console.log(`[${cfg.name}] Task completed`)
        },
      })
      console.log(`[${cfg.name}] Started: ${worker.id} (task: ${cfg.task}, contribution: ${cfg.contribution})`)
      return { agent: worker, ...cfg }
    })
  )

  await delay(3000)

  const peers = await client.findPeers({
    requiredCapabilities: [{ type: 'agent', name: 'distributed-worker' }],
  })

  if (peers.length === 0) {
    console.error('No workers found!')
    await Promise.all([client.stop(), ...workers.map((w) => w.agent.stop())])
    process.exit(1)
  }

  console.log(`\n[client] Found ${peers.length} workers, sending job requests...`)

  const jobId = `swarm-job-${Date.now()}`
  await Promise.all(
    workers.map((w) => client.request(w.agent.id, `Execute task: ${w.task}`))
  )

  console.log(`[client] All workers responded`)

  const participants = workers.map((w) => ({
    peerId: w.agent.id,
    walletAddress: w.agent.address!,
    contribution: w.contribution,
  }))

  console.log(`\n[client] Creating swarm split...`)
  const result = await client.payments.distributeToSwarm(jobId, {
    totalAmount: '0.003',
    chainId: ETH_SEPOLIA_CHAIN_ID,
    token: 'ETH',
    participants,
  })

  console.log(`[client] Swarm split created: ${result.splitId}`)
  console.log(`[client] Invoices queued: ${result.invoicesSent}`)

  const invoices = client.payments.getPendingInvoices()
  console.log(`\n[client] Payment distribution:`)
  for (const inv of invoices) {
    console.log(`  - ${inv.amount} ETH to ${inv.recipient.slice(0, 10)}...`)
  }

  if (invoices.length > 0 && client.wallet) {
    console.log(`\n[client] Processing batch settlement...`)
    const settlements = await client.payments.settleAll()
    for (const s of settlements) {
      if (s.success) {
        console.log(`[client] Paid ${s.aggregatedInvoice.totalAmount} ETH`)
        console.log(`[client] TX: ${s.txHash}`)
        console.log(`[client] View: https://sepolia.etherscan.io/tx/${s.txHash}`)
      } else {
        console.log(`[client] Payment failed: ${s.error}`)
      }
    }
  } else if (invoices.length > 0) {
    console.log(`\n[client] Invoices queued for later settlement (no wallet)`)
  }

  console.log('\n=== Summary ===')
  console.log(`Total distributed: ${result.totalAmount} ETH`)
  console.log(`Workers paid: ${result.invoicesSent}`)

  await Promise.all([client.stop(), ...workers.map((w) => w.agent.stop())])
  console.log('\nDone!')
  process.exit(0)
}

main().catch(console.error)
