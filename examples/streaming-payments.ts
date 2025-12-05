import { createAgent, delay, type StreamGenerateFn } from '@ecco/core'

const ETH_SEPOLIA_CHAIN_ID = 11155111
const RATE_PER_TOKEN = '0.0001'

const streamGenerate: StreamGenerateFn = async function* (_options) {
  const words = ['Here', 'is', 'some', 'generated', 'content', 'for', 'you!']
  for (const word of words) {
    await delay(100)
    yield { text: word + ' ', tokens: 1 }
  }
}

async function main(): Promise<void> {
  console.log('=== Streaming Payments Example ===\n')

  const rpcUrls: Record<number, string> = {}
  if (process.env.RPC_URL) {
    rpcUrls[ETH_SEPOLIA_CHAIN_ID] = process.env.RPC_URL
  }

  const service = await createAgent({
    name: 'streaming-service',
    capabilities: [{ type: 'agent', name: 'text-generator', version: '1.0.0' }],
    personality: 'helpful assistant',
    model: {},
    streamGenerateFn: streamGenerate,
    wallet: process.env.SERVICE_PRIVATE_KEY
      ? { privateKey: process.env.SERVICE_PRIVATE_KEY, rpcUrls }
      : undefined,
    pricing: {
      type: 'streaming',
      chainId: ETH_SEPOLIA_CHAIN_ID,
      ratePerToken: RATE_PER_TOKEN,
    },
  })

  console.log(`[service] Started: ${service.id}`)
  console.log(`[service] Wallet: ${service.address ?? 'simulation mode'}`)

  const client = await createAgent({
    name: 'streaming-client',
    network: service.addrs,
    capabilities: [],
    wallet: process.env.CLIENT_PRIVATE_KEY
      ? { privateKey: process.env.CLIENT_PRIVATE_KEY, rpcUrls }
      : undefined,
  })

  console.log(`[client] Started: ${client.id}`)
  console.log(`[client] Wallet: ${client.address ?? 'simulation mode'}\n`)

  await delay(3000)

  const peers = await client.findPeers({
    requiredCapabilities: [{ type: 'agent', name: 'text-generator' }],
  })

  if (peers.length === 0) {
    console.error('Service not found!')
    await Promise.all([service.stop(), client.stop()])
    process.exit(1)
  }

  console.log(`[client] Found service, sending request...`)
  const response = await client.request(peers[0].peer.id, 'Generate some content')
  console.log(`[client] Response:`, response.response)

  await delay(1000)

  const invoices = client.payments.getPendingInvoices()
  console.log(`\n[client] Received ${invoices.length} invoice(s)`)

  if (invoices.length > 0 && client.wallet) {
    const results = await client.payments.settleAll()
    for (const result of results) {
      if (result.success) {
        console.log(`[client] Paid ${result.aggregatedInvoice.totalAmount} ETH`)
        console.log(`[client] TX: ${result.txHash}`)
      }
    }
  }

  await Promise.all([client.stop(), service.stop()])
  console.log('\nDone!')
  process.exit(0)
}

main().catch(console.error)
