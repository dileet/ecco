import {
  Node,
  type NodeState,
  PaymentProtocol,
  Wallet,
  type EccoEvent,
  setStreamingChannel,
  updateStreamingChannel,
  addPaymentLedgerEntry,
  enqueueSettlement,
  getNodeState,
} from '@ecco/core';
import type { StreamingAgreement, Invoice } from '@ecco/core';

const ETH_SEPOLIA_CHAIN_ID = 11155111;

const SERVICE_KEY_PATH = '.keys/service-agent.json';
const CLIENT_KEY_PATH = '.keys/client-agent.json';

async function createServiceAgent(
  id: string,
  port: number,
  registryUrl?: string,
  walletRpcUrls?: Record<number, string>
): Promise<NodeState> {
  const agentState = Node.create({
    discovery: registryUrl ? ['mdns', 'gossip', 'registry'] : ['mdns', 'gossip'],
    registry: registryUrl,
    nodeId: id,
    authentication: {
      enabled: true,
      walletAutoInit: true,
      keyPath: SERVICE_KEY_PATH,
      walletRpcUrls,
    },
    capabilities: [
      {
        type: 'agent',
        name: 'streaming-text-generator',
        version: '1.0.0',
        metadata: {
          streamingRate: '0.0001',
          token: 'ETH',
        },
      },
    ],
    transport: {
      websocket: { enabled: true, port },
    },
  });

  let agent = await Node.start(agentState);

  const walletAddress = await Wallet.getAddress(agent);
  console.log(`[${id}] Wallet address: ${walletAddress}`);
  console.log(`[${id}] Streaming rate: 0.0001 ETH per token\n`);

  const streamingChannels = new Map<string, StreamingAgreement>();

  Node.subscribeToTopic(agent, `peer:${Node.getId(agent)}`, async (event) => {
    if (event.type !== 'message') return;

    const message = event.payload as { type: string; payload: unknown };

    if (PaymentProtocol.isStreamingTickMessage(message)) {
      const tick = message.payload as {
        channelId: string;
        tokensGenerated: number;
        amountOwed: string;
        timestamp: number;
      };

      let channel = streamingChannels.get(tick.channelId);
      if (!channel) {
        const walletAddress = await Wallet.getAddress(agent);
        channel = PaymentProtocol.createStreamingAgreement(
          `job-${tick.channelId}`,
          event.from,
          walletAddress,
          ETH_SEPOLIA_CHAIN_ID,
          'ETH',
          '0.0001'
        );
        channel.id = tick.channelId;
        streamingChannels.set(tick.channelId, channel);
        
        if (agent._ref) {
          await setStreamingChannel(agent._ref, channel);
        }
        console.log(`[${id}] Created new streaming channel: ${tick.channelId}`);
      }

      console.log(`[${id}] Received streaming tick: ${tick.tokensGenerated} tokens, ${tick.amountOwed} ETH owed`);

      const updated = PaymentProtocol.recordStreamingTick(channel, tick.tokensGenerated);
      streamingChannels.set(tick.channelId, updated.agreement);

      if (agent._ref) {
        await updateStreamingChannel(agent._ref, tick.channelId, () => updated.agreement);
      }

      if (parseFloat(updated.amountOwed) > 0) {
        const walletAddress = await Wallet.getAddress(agent);
        const invoice = PaymentProtocol.createInvoice(
          channel.jobId,
          channel.chainId,
          updated.amountOwed,
          channel.token,
          walletAddress,
          Date.now() + 3600000
        );

        const invoiceMessage = PaymentProtocol.createInvoiceMessage(
          Node.getId(agent),
          channel.payer,
          invoice
        );

        await Node.sendMessage(agent, channel.payer, invoiceMessage);
        console.log(`[${id}] Sent invoice for ${updated.amountOwed} ETH (this tick)`);
        console.log(`[${id}] Total accumulated: ${updated.agreement.accumulatedAmount} ETH`);
      }
    }
  });

  console.log(`[${id}] Service agent started on port ${port}`);
  return agent;
}

async function createClientAgent(
  id: string,
  port: number,
  registryUrl?: string,
  walletRpcUrls?: Record<number, string>
): Promise<NodeState> {
  const agentState = Node.create({
    discovery: registryUrl ? ['mdns', 'gossip', 'registry'] : ['mdns', 'gossip'],
    registry: registryUrl,
    nodeId: id,
    authentication: {
      enabled: true,
      walletAutoInit: true,
      keyPath: CLIENT_KEY_PATH,
      walletRpcUrls,
    },
    capabilities: [],
    transport: {
      websocket: { enabled: true, port },
    },
  });

  let agent = await Node.start(agentState);

  const walletAddress = await Wallet.getAddress(agent);
  console.log(`[${id}] Wallet address: ${walletAddress}\n`);

  const receivedInvoices: Invoice[] = [];

  Node.subscribeToTopic(agent, `peer:${Node.getId(agent)}`, async (event) => {
    if (event.type !== 'message') return;

    const message = event.payload as { type: string; payload: unknown };

    if (PaymentProtocol.isInvoiceMessage(message)) {
      const invoice = message.payload as Invoice;
      receivedInvoices.push(invoice);
      console.log(`[${id}] Received invoice: ${invoice.amount} ETH`);

      const ledgerEntry = PaymentProtocol.createPaymentLedgerEntry(
        'streaming',
        invoice.chainId,
        invoice.token,
        invoice.amount,
        invoice.recipient,
        Node.getId(agent),
        invoice.jobId
      );

      const settlementIntent = PaymentProtocol.createSettlementIntent(
        'streaming',
        ledgerEntry.id,
        invoice
      );

      if (agent._ref) {
        await addPaymentLedgerEntry(agent._ref, ledgerEntry);
        await enqueueSettlement(agent._ref, settlementIntent);
      }

      console.log(`[${id}] Settlement queued for offline processing`);
    }
  });

  console.log(`[${id}] Client agent started on port ${port}`);
  return agent;
}

async function startStreamingJob(
  agent: NodeState,
  servicePeerId: string
): Promise<void> {
  console.log(`\n[${Node.getId(agent)}] Starting streaming job with ${servicePeerId}`);

  const payerId = Node.getId(agent);
  const jobId = `streaming-job-${Date.now()}`;
  const channelId = `channel-${jobId}`;

  console.log(`[${Node.getId(agent)}] Channel ID: ${channelId}`);
  console.log(`[${Node.getId(agent)}] Rate: 0.0001 ETH per token`);

  const tokensToGenerate = [10, 15, 20, 25, 30];
  let totalTokens = 0;

  for (const tokenCount of tokensToGenerate) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    totalTokens += tokenCount;
    const ratePerToken = 0.0001;
    const amountOwed = (ratePerToken * tokenCount).toString();

    const tickMessage = PaymentProtocol.createStreamingTickMessage(
      Node.getId(agent),
      servicePeerId,
      channelId,
      tokenCount,
      amountOwed
    );

    await Node.sendMessage(agent, servicePeerId, tickMessage);
    console.log(`[${Node.getId(agent)}] Sent tick: ${tokenCount} tokens (total: ${totalTokens})`);
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log(`\n[${Node.getId(agent)}] Streaming complete!`);
  console.log(`[${Node.getId(agent)}] Total tokens sent: ${totalTokens}`);

  if (agent._ref) {
    const state = await getNodeState(agent._ref);
    console.log(`[${Node.getId(agent)}] Pending settlements: ${state.pendingSettlements.length}`);
    
    if (state.pendingSettlements.length > 0) {
      console.log(`[${Node.getId(agent)}] Processing settlements...`);
      state.pendingSettlements.forEach((intent, i) => {
        console.log(`[${Node.getId(agent)}]   Settlement ${i + 1}: ${intent.invoice?.amount || 'no invoice'} ETH to ${intent.invoice?.recipient || 'unknown'}`);
      });

      const processed = await Wallet.processSettlements(agent);
      console.log(`[${Node.getId(agent)}] Processed ${processed} settlements`);
      
      if (processed > 0) {
        const finalState = await getNodeState(agent._ref);
        console.log(`\n[${Node.getId(agent)}] Transaction Details:`);
        finalState.paymentLedger.forEach((entry) => {
          if (entry.status === 'settled' && entry.txHash) {
            const explorerUrl = `https://sepolia.etherscan.io/tx/${entry.txHash}`;
            console.log(`[${Node.getId(agent)}]   ${entry.amount} ${entry.token} -> ${entry.txHash}`);
            console.log(`[${Node.getId(agent)}]   View on Etherscan: ${explorerUrl}`);
          }
        });
      }
      
      if (processed === 0 && state.pendingSettlements.length > 0) {
        console.log(`[${Node.getId(agent)}] WARNING: No settlements were processed. Check wallet balance and RPC connection.`);
      }
    } else {
      console.log(`[${Node.getId(agent)}] No settlements to process`);
    }
  }
}

async function main() {
  console.log('=== Streaming Payments Example ===\n');
  console.log('This example demonstrates:');
  console.log('1. Client creates streaming agreement (0.0001 ETH per token)');
  console.log('2. Service generates tokens and sends streaming ticks');
  console.log('3. Client accumulates payment per token generated');
  console.log('4. Payments are queued for offline settlement');
  console.log('5. Settlements are processed when online\n');

  const registryUrl = process.env.REGISTRY_URL;
  const ethRpcUrl = process.env.RPC_URL;

  const walletRpcUrls: Record<number, string> = {};

  if (ethRpcUrl) {
    if (!ethRpcUrl.startsWith('http://') && !ethRpcUrl.startsWith('https://')) {
      console.error('ERROR: Invalid RPC_URL format. Must start with http:// or https://');
      process.exit(1);
    }
    walletRpcUrls[ETH_SEPOLIA_CHAIN_ID] = ethRpcUrl;
    console.log(`Using Ethereum Sepolia RPC: ${ethRpcUrl.replace(/\/v2\/[^/]+$/, '/v2/***')}`);
  } else {
    console.warn('WARNING: No RPC_URL provided. Using default public RPC endpoint.\n');
  }

  const serviceAgent = await createServiceAgent('streaming-service', 7781, registryUrl, walletRpcUrls);
  const clientAgent = await createClientAgent('streaming-client', 7782, registryUrl, walletRpcUrls);

  console.log('\nWaiting for peers to discover...\n');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const { matches, state: updatedClientAgent } = await Node.findPeers(clientAgent, {
    requiredCapabilities: [
      {
        type: 'agent',
        name: 'streaming-text-generator',
      },
    ],
  });

  if (matches.length === 0) {
    console.error('Service agent not found!');
    await Node.stop(serviceAgent);
    await Node.stop(clientAgent);
    return;
  }

  const servicePeer = matches[0].peer;
  console.log(`Found service peer: ${servicePeer.id}\n`);

  await startStreamingJob(updatedClientAgent, servicePeer.id);

  await Node.stop(serviceAgent);
  await Node.stop(clientAgent);

  console.log('\n=== Example Complete ===');
}

main().catch(console.error);

