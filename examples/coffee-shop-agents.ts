import { streamText, generateText, tool } from 'ai'
import { openai } from '@ai-sdk/openai'
import { z } from 'zod'
import {
  createAgent,
  delay,
  type Agent,
  type StreamGenerateFn,
} from '@ecco/core'

const MODEL = openai('gpt-4o-mini')

const MENU: Record<string, Record<string, string>> = {
  Latte: { small: '0.003', large: '0.005' },
  Espresso: { single: '0.002', double: '0.003' },
  Cappuccino: { small: '0.0035', large: '0.0055' },
  Americano: { small: '0.0025', large: '0.004' },
}

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

async function createCoffeeShopAgent(): Promise<Agent> {
  const rpcUrls: Record<number, string> = {}
  if (process.env.RPC_URL) {
    rpcUrls[11155111] = process.env.RPC_URL
  }

  const coffeeShopAgent = await createAgent({
    name: 'starbucks-downtown',
    capabilities: [
      { type: 'business', name: 'coffee-shop', version: '1.0.0' },
      { type: 'service', name: 'food-ordering', version: '1.0.0' },
    ],
    wallet: { rpcUrls },

    handler: async (msg, ctx) => {
      const { prompt } = msg.payload as { prompt: string }

      const getMenuTool = tool({
        description: 'Get the coffee menu with all available items and their prices',
        inputSchema: z.object({}),
        execute: async () => {
          console.log(`[${coffeeShopAgent.id.slice(0, 12)}...] Tool called: getMenu`)
          return {
            shopName: 'Starbucks Downtown',
            items: Object.entries(MENU).map(([name, sizes]) => ({
              name,
              sizes: Object.fromEntries(
                Object.entries(sizes).map(([size, price]) => [size, `${price} ETH`])
              ),
            })),
            currency: 'ETH',
            note: 'Prices shown in ETH on Sepolia testnet',
          }
        },
      })

      const orderCoffeeTool = tool({
        description: 'Place an order for a coffee drink. Requires item name and size.',
        inputSchema: z.object({
          item: z.string().describe('The coffee item to order (e.g., Latte, Espresso)'),
          size: z.string().describe('The size of the drink (e.g., small, large, single, double)'),
        }),
        execute: async ({ item, size }) => {
          console.log(`[${coffeeShopAgent.id.slice(0, 12)}...] Tool called: orderCoffee(${item}, ${size})`)

          const itemPrices = MENU[item]
          if (!itemPrices) {
            return { error: `Unknown item: ${item}. Available items: ${Object.keys(MENU).join(', ')}` }
          }

          const price = itemPrices[size]
          if (!price) {
            return { error: `Unknown size: ${size}. Available sizes for ${item}: ${Object.keys(itemPrices).join(', ')}` }
          }

          if (ctx.agent.wallet) {
            try {
              const invoice = await ctx.agent.payments.createInvoice(ctx, {
                type: 'escrow',
                chainId: 11155111,
                amount: price,
                token: 'ETH',
              })
              console.log(`[${coffeeShopAgent.id.slice(0, 12)}...] Invoice created: ${invoice.id}`)
              await ctx.reply({ invoice }, 'invoice')
              console.log(`[${coffeeShopAgent.id.slice(0, 12)}...] Invoice sent to customer`)
            } catch (err) {
              console.log(`[${coffeeShopAgent.id.slice(0, 12)}...] Payment setup skipped (no wallet configured)`)
            }
          }

          const orderId = crypto.randomUUID().slice(0, 8)
          const pickupTime = new Date(Date.now() + 5 * 60 * 1000).toLocaleTimeString()

          return {
            orderId,
            item,
            size,
            price: `${price} ETH`,
            status: 'confirmed',
            pickupTime,
            message: `Your ${size} ${item} will be ready at ${pickupTime}. Order #${orderId}`,
          }
        },
      })

      const checkOrderStatusTool = tool({
        description: 'Check the status of an existing order',
        inputSchema: z.object({
          orderId: z.string().describe('The order ID to check'),
        }),
        execute: async ({ orderId }) => {
          console.log(`[${coffeeShopAgent.id.slice(0, 12)}...] Tool called: checkOrderStatus(${orderId})`)
          return {
            orderId,
            status: 'preparing',
            estimatedReady: '2 minutes',
          }
        },
      })

      try {
        const result = await generateText({
          model: MODEL,
          system: `You are a friendly coffee shop assistant at Starbucks Downtown.
Help customers view the menu and place orders.
When a customer wants to order, use the orderCoffee tool with the correct item and size.
Be helpful and suggest popular items if asked.`,
          tools: {
            getMenu: getMenuTool,
            orderCoffee: orderCoffeeTool,
            checkOrderStatus: checkOrderStatusTool,
          },
          prompt,
        })

        await ctx.reply({ requestId: msg.id, response: result.text, toolResults: result.steps })
      } catch (error) {
        console.error(`[${coffeeShopAgent.id.slice(0, 12)}...] Error:`, error)
        await ctx.reply({ requestId: msg.id, error: 'Sorry, I encountered an error processing your request.' })
      }
    },
  })

  return coffeeShopAgent
}

async function createCustomerAgent(bootstrapAddrs?: string[]): Promise<Agent> {
  const rpcUrls: Record<number, string> = {}
  if (process.env.RPC_URL) {
    rpcUrls[11155111] = process.env.RPC_URL
  }

  const customerAgent = await createAgent({
    name: 'johns-assistant',
    network: bootstrapAddrs,
    capabilities: [{ type: 'personal', name: 'assistant', version: '1.0.0' }],
    systemPrompt: 'You are a helpful personal assistant who helps the user order food and drinks.',
    model: MODEL,
    streamGenerateFn: streamGenerate,
    wallet: { rpcUrls },
  })

  return customerAgent
}

async function main(): Promise<void> {
  console.log('=== Coffee Shop Agent Example ===\n')

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is required')
    process.exit(1)
  }

  console.log('--- Creating Coffee Shop Agent ---\n')
  const coffeeShop = await createCoffeeShopAgent()
  console.log(`[coffee-shop] Started with ID: ${coffeeShop.id.slice(0, 20)}...`)
  console.log(`[coffee-shop] Addresses: ${coffeeShop.addrs.slice(0, 2).join(', ')}...`)

  await delay(1000)

  console.log('\n--- Creating Customer Agent ---\n')
  const customer = await createCustomerAgent(coffeeShop.addrs)
  console.log(`[customer] Started with ID: ${customer.id.slice(0, 20)}...`)

  await delay(2000)

  console.log('\n--- Discovering Nearby Coffee Shops ---\n')

  const nearbyShops = await customer.findPeers({
    requiredCapabilities: [{ type: 'business', name: 'coffee-shop' }],
  })

  if (nearbyShops.length === 0) {
    console.log('[customer] No coffee shops found nearby')
    await coffeeShop.stop()
    await customer.stop()
    process.exit(0)
  }

  console.log(`[customer] Found ${nearbyShops.length} coffee shop(s):`)
  for (const shop of nearbyShops) {
    console.log(`  - ${shop.peer.id.slice(0, 20)}... (score: ${shop.matchScore})`)
  }

  const targetShop = nearbyShops[0]

  console.log('\n--- Requesting Menu ---\n')

  const menuResult = await customer.request(targetShop.peer.id, "What's on the menu?")
  const menuResponse = menuResult.response as { response?: string; toolResults?: Array<{ content: Array<{ type: string; output?: unknown }> }> }
  if (menuResponse.response) {
    console.log(`[coffee-shop] Menu response: ${menuResponse.response.slice(0, 200)}...`)
  } else if (menuResponse.toolResults) {
    console.log(`[coffee-shop] Menu (from tool results):`)
    for (const step of menuResponse.toolResults) {
      for (const item of step.content) {
        if (item.type === 'tool-result' && item.output) {
          console.log(JSON.stringify(item.output, null, 2))
        }
      }
    }
  }

  console.log('\n--- Placing an Order ---\n')

  const orderResult = await customer.request(
    targetShop.peer.id,
    "I'd like to order a large Latte please"
  )
  const orderResponse = orderResult.response as { response?: string; toolResults?: Array<{ content: Array<{ type: string; output?: unknown }> }> }
  if (orderResponse.response) {
    console.log(`[coffee-shop] Order response: ${orderResponse.response}`)
  } else if (orderResponse.toolResults) {
    console.log(`[coffee-shop] Order (from tool results):`)
    for (const step of orderResponse.toolResults) {
      for (const item of step.content) {
        if (item.type === 'tool-result' && item.output) {
          console.log(JSON.stringify(item.output, null, 2))
        }
      }
    }
  }

  console.log('\n--- Using Priority Discovery (Proximity First) ---\n')

  try {
    const proximityResult = await customer.query(
      'What coffee drinks do you recommend for someone who likes sweet drinks?',
      {
        discovery: {
          phases: ['proximity', 'local'],
          capabilityQuery: {
            requiredCapabilities: [{ type: 'business', name: 'coffee-shop' }],
          },
          minPeers: 1,
        },
        timeout: 30000,
      }
    )

    console.log(`[consensus] Response: ${proximityResult.text}`)
    console.log(`[consensus] Confidence: ${(proximityResult.consensus.confidence * 100).toFixed(1)}%`)
    console.log(`[consensus] Agents: ${proximityResult.metrics.successfulAgents}/${proximityResult.metrics.totalAgents}`)
  } catch (error) {
    console.log('[consensus] Query failed (expected with single agent):', (error as Error).message)
  }

  console.log('\n--- Checking Pending Payments ---\n')

  const pendingInvoices = customer.payments.getPendingInvoices()
  if (pendingInvoices.length > 0) {
    console.log(`[customer] Pending invoices: ${pendingInvoices.length}`)
    for (const invoice of pendingInvoices) {
      console.log(`  - Invoice ${invoice.id}: ${invoice.amount} ${invoice.token}`)
    }

    if (customer.wallet) {
      console.log('\n[customer] Settling all pending invoices...')
      try {
        const settlements = await customer.payments.settleAll()
        for (const settlement of settlements) {
          if (settlement.success) {
            console.log(`  - Settled ${settlement.aggregatedInvoice.totalAmount} ${settlement.aggregatedInvoice.token}`)
            console.log(`    TX: ${settlement.txHash}`)
          } else {
            console.log(`  - Settlement failed: ${settlement.error}`)
          }
        }
      } catch (err) {
        console.log(`  - Settlement skipped: ${(err as Error).message}`)
      }
    }
  } else {
    console.log('[customer] No pending invoices')
  }

  console.log('\n--- Shutting Down ---\n')

  console.log('\nExample complete!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
