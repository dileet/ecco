import {
  ecco,
  stop,
  findPeers,
  sendMessage,
  delay,
  broadcastCapabilities,
  generateKeyPair,
  exportPublicKey,
  exportPrivateKey,
  importPublicKey,
  importPrivateKey,
  signMessage,
  verifyMessage,
  isMessageFresh,
  createWalletState,
  getAddress,
  getLibp2pPeerId,
  batchSettle,
  recordStreamingTick,
  writeStreamingChannel,
  updateStreamingChannel,
  writePaymentLedgerEntry,
  writeSettlement,
  storageInitialize,
  type EccoNode,
  type Message,
  type AuthState,
  type WalletState,
  type StreamingAgreement,
  type Invoice,
  type PaymentLedgerEntry,
  type SettlementIntent,
} from '@ecco/core';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';

const ETH_SEPOLIA_CHAIN_ID = 11155111;
const RATE_PER_TOKEN = '0.0001';

const SERVICE_KEY_PATH = '.keys/service-agent.json';
const CLIENT_KEY_PATH = '.keys/client-agent.json';

interface StoredKeys {
  algorithm: string;
  privateKey: string;
  publicKey: string;
  ethereumPrivateKey: `0x${string}`;
}

async function loadOrCreateKeys(keyPath: string): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  ethereumPrivateKey: `0x${string}`;
}> {
  const fullPath = join(process.cwd(), keyPath);

  if (existsSync(fullPath)) {
    const content = await readFile(fullPath, 'utf-8');
    const stored: StoredKeys = JSON.parse(content);

    const privateKey = await importPrivateKey(stored.privateKey);
    const publicKey = await importPublicKey(stored.publicKey);

    return {
      privateKey,
      publicKey,
      ethereumPrivateKey: stored.ethereumPrivateKey,
    };
  }

  const { privateKey, publicKey } = await generateKeyPair();
  const privateKeyStr = await exportPrivateKey(privateKey);
  const publicKeyStr = await exportPublicKey(publicKey);

  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const ethereumPrivateKey = `0x${Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}` as `0x${string}`;

  const stored: StoredKeys = {
    algorithm: 'ECDSA-P-256',
    privateKey: privateKeyStr,
    publicKey: publicKeyStr,
    ethereumPrivateKey,
  };

  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(fullPath, JSON.stringify(stored));
  console.log(`Created new keys at ${keyPath}`);

  return { privateKey, publicKey, ethereumPrivateKey };
}

interface AgentState {
  node: EccoNode;
  auth: AuthState;
  wallet: WalletState | null;
  streamingChannels: Map<string, StreamingAgreement>;
  receivedInvoices: Invoice[];
  pendingSettlements: SettlementIntent[];
  paymentLedger: PaymentLedgerEntry[];
}

async function createServiceAgent(
  name: string,
  walletRpcUrls?: Record<number, string>
): Promise<AgentState> {
  console.log(`[${name}] Initializing service agent...`);

  await storageInitialize(name);

  const keys = await loadOrCreateKeys(SERVICE_KEY_PATH);
  const auth: AuthState = {
    config: { enabled: true, privateKey: keys.privateKey, publicKey: keys.publicKey },
    keyCache: new Map(),
  };

  const pubKeyStr = await exportPublicKey(keys.publicKey);
  console.log(`[${name}] Auth public key: ${pubKeyStr.slice(0, 32)}...`);

  let wallet: WalletState | null = null;
  if (walletRpcUrls && Object.keys(walletRpcUrls).length > 0) {
    wallet = createWalletState({
      privateKey: keys.ethereumPrivateKey,
      rpcUrls: walletRpcUrls,
    });
    console.log(`[${name}] Wallet address: ${getAddress(wallet)}`);
  } else {
    console.log(`[${name}] Running in simulation mode (no wallet)`);
  }

  const streamingChannels = new Map<string, StreamingAgreement>();
  let nodeRef: EccoNode | null = null;

  const node = await ecco(
    {
      discovery: ['mdns', 'gossip'],
      nodeId: name,
      capabilities: [
        {
          type: 'agent',
          name: 'streaming-text-generator',
          version: '1.0.0',
          metadata: {
            streamingRate: RATE_PER_TOKEN,
            token: 'ETH',
            chainId: ETH_SEPOLIA_CHAIN_ID,
          },
        },
      ],
      transport: {
        websocket: { enabled: true },
      },
    },
    {
      onMessage: async (message: Message) => {
        if (message.signature && message.publicKey) {
          const { valid } = await verifyMessage(auth, message as Message & { signature: string; publicKey: string });
          if (!valid) {
            console.log(`[${name}] Rejected message with invalid signature`);
            return;
          }
          if (!isMessageFresh(message)) {
            console.log(`[${name}] Rejected stale message`);
            return;
          }
        }

        if (message.type === 'streaming-tick') {
          const tick = message.payload as {
            channelId: string;
            tokensGenerated: number;
            amountOwed: string;
            timestamp: number;
            sourcePeerId?: string;
          };

          let channel = streamingChannels.get(tick.channelId);
          if (!channel) {
            channel = {
              id: tick.channelId,
              jobId: `job-${tick.channelId}`,
              payer: message.from,
              recipient: wallet ? getAddress(wallet) : name,
              chainId: ETH_SEPOLIA_CHAIN_ID,
              token: 'ETH',
              ratePerToken: RATE_PER_TOKEN,
              accumulatedAmount: '0',
              lastTick: Date.now(),
              status: 'active',
              createdAt: Date.now(),
            };
            streamingChannels.set(tick.channelId, channel);
            await writeStreamingChannel(channel);
            console.log(`[${name}] Created streaming channel: ${tick.channelId}`);
          }

          const { agreement: updated, amountOwed } = recordStreamingTick(channel, tick.tokensGenerated);
          streamingChannels.set(tick.channelId, updated);
          await updateStreamingChannel(updated);

          console.log(`[${name}] Received tick: ${tick.tokensGenerated} tokens, ${amountOwed} ETH owed (total: ${updated.accumulatedAmount} ETH)`);

          const replyPeerId = tick.sourcePeerId ?? message.from;
          if (parseFloat(amountOwed) > 0 && nodeRef && tick.sourcePeerId) {
            const invoice: Invoice = {
              id: crypto.randomUUID(),
              jobId: channel.jobId,
              chainId: channel.chainId,
              amount: amountOwed,
              token: channel.token,
              recipient: channel.recipient,
              validUntil: Date.now() + 3600000,
            };

            const invoiceMessage: Message = {
              id: crypto.randomUUID(),
              from: nodeRef.id,
              to: replyPeerId,
              type: 'invoice',
              payload: invoice,
              timestamp: Date.now(),
            };

            const signedInvoice = await signMessage(auth, invoiceMessage);
            await sendMessage(nodeRef.ref, replyPeerId, signedInvoice);
            console.log(`[${name}] Sent invoice for ${amountOwed} ETH`);
          }
        }
      },
    }
  );

  nodeRef = node;
  console.log(`[${name}] Started with ID: ${node.id}`);

  return {
    node,
    auth,
    wallet,
    streamingChannels,
    receivedInvoices: [],
    pendingSettlements: [],
    paymentLedger: [],
  };
}

async function createClientAgent(
  name: string,
  walletRpcUrls?: Record<number, string>
): Promise<AgentState> {
  console.log(`\n[${name}] Initializing client agent...`);

  await storageInitialize(name);

  const keys = await loadOrCreateKeys(CLIENT_KEY_PATH);
  const auth: AuthState = {
    config: { enabled: true, privateKey: keys.privateKey, publicKey: keys.publicKey },
    keyCache: new Map(),
  };

  const pubKeyStr = await exportPublicKey(keys.publicKey);
  console.log(`[${name}] Auth public key: ${pubKeyStr.slice(0, 32)}...`);

  let wallet: WalletState | null = null;
  if (walletRpcUrls && Object.keys(walletRpcUrls).length > 0) {
    wallet = createWalletState({
      privateKey: keys.ethereumPrivateKey,
      rpcUrls: walletRpcUrls,
    });
    console.log(`[${name}] Wallet address: ${getAddress(wallet)}`);
  } else {
    console.log(`[${name}] Running in simulation mode (no wallet)`);
  }

  const receivedInvoices: Invoice[] = [];
  const pendingSettlements: SettlementIntent[] = [];
  const paymentLedger: PaymentLedgerEntry[] = [];

  const node = await ecco(
    {
      discovery: ['mdns', 'gossip'],
      nodeId: name,
      capabilities: [],
      transport: {
        websocket: { enabled: true },
      },
    },
    {
      onMessage: async (message: Message) => {
        if (message.signature && message.publicKey) {
          const { valid } = await verifyMessage(auth, message as Message & { signature: string; publicKey: string });
          if (!valid) {
            console.log(`[${name}] Rejected message with invalid signature`);
            return;
          }
          if (!isMessageFresh(message)) {
            console.log(`[${name}] Rejected stale message`);
            return;
          }
        }

        if (message.type === 'invoice') {
          const invoice = message.payload as Invoice;
          receivedInvoices.push(invoice);
          console.log(`[${name}] Received invoice: ${invoice.amount} ETH to ${invoice.recipient.slice(0, 10)}...`);

          const ledgerEntry: PaymentLedgerEntry = {
            id: crypto.randomUUID(),
            type: 'streaming',
            status: 'pending',
            chainId: invoice.chainId,
            token: invoice.token,
            amount: invoice.amount,
            recipient: invoice.recipient,
            payer: name,
            jobId: invoice.jobId,
            createdAt: Date.now(),
          };
          paymentLedger.push(ledgerEntry);
          await writePaymentLedgerEntry(ledgerEntry);

          const settlement: SettlementIntent = {
            id: crypto.randomUUID(),
            type: 'streaming',
            ledgerEntryId: ledgerEntry.id,
            invoice,
            priority: 1,
            createdAt: Date.now(),
            retryCount: 0,
            maxRetries: 3,
          };
          pendingSettlements.push(settlement);
          await writeSettlement(settlement);

          console.log(`[${name}] Queued settlement for ${invoice.amount} ETH`);
        }
      },
    }
  );

  console.log(`[${name}] Started with ID: ${node.id}`);

  return {
    node,
    auth,
    wallet,
    streamingChannels: new Map(),
    receivedInvoices,
    pendingSettlements,
    paymentLedger,
  };
}

interface StreamingJobResult {
  totalTokens: number;
  expectedCost: string;
  transactions: Array<{ amount: string; txHash: string }>;
}

async function startStreamingJob(
  client: AgentState,
  servicePeerId: string
): Promise<StreamingJobResult> {
  const clientId = client.node.id;
  const channelId = `channel-${crypto.randomUUID()}`;

  console.log(`\n[${clientId}] Starting streaming job with ${servicePeerId}`);
  console.log(`[${clientId}] Channel ID: ${channelId}`);
  console.log(`[${clientId}] Rate: ${RATE_PER_TOKEN} ETH per token\n`);

  const tokenBatches = [10, 15, 20, 25, 30];
  let totalTokens = 0;

  for (const tokenCount of tokenBatches) {
    await delay(1000);

    totalTokens += tokenCount;
    const amountOwed = (parseFloat(RATE_PER_TOKEN) * tokenCount).toFixed(6);

    const tickMessage: Message = {
      id: crypto.randomUUID(),
      from: clientId,
      to: servicePeerId,
      type: 'streaming-tick',
      payload: {
        channelId,
        tokensGenerated: tokenCount,
        amountOwed,
        timestamp: Date.now(),
        sourcePeerId: getLibp2pPeerId(client.node.ref),
      },
      timestamp: Date.now(),
    };

    const signedTick = await signMessage(client.auth, tickMessage);
    await sendMessage(client.node.ref, servicePeerId, signedTick);
    console.log(`[${clientId}] Sent tick: ${tokenCount} tokens (total: ${totalTokens})`);
  }

  await delay(3000);

  console.log(`\n[${clientId}] Streaming complete!`);
  console.log(`[${clientId}] Total tokens: ${totalTokens}`);
  console.log(`[${clientId}] Expected cost: ${(parseFloat(RATE_PER_TOKEN) * totalTokens).toFixed(6)} ETH`);
  console.log(`[${clientId}] Pending settlements: ${client.pendingSettlements.length}`);

  const transactions: Array<{ amount: string; txHash: string }> = [];

  if (client.wallet && client.pendingSettlements.length > 0) {
    console.log(`\n[${clientId}] Processing batch settlement...`);

    const invoices = client.pendingSettlements
      .map((s) => s.invoice)
      .filter((inv): inv is Invoice => inv !== undefined);

    console.log(`[${clientId}] Aggregating ${invoices.length} invoices into batch payment...`);

    try {
      const results = await batchSettle(client.wallet, invoices);

      for (const result of results) {
        if (result.success) {
          transactions.push({ amount: result.aggregatedInvoice.totalAmount, txHash: result.txHash });
          console.log(`[${clientId}] Batch payment successful!`);
          console.log(`[${clientId}] Total amount: ${result.aggregatedInvoice.totalAmount} ETH`);
          console.log(`[${clientId}] Invoices settled: ${result.aggregatedInvoice.invoiceIds.length}`);
          console.log(`[${clientId}] Transaction hash: ${result.txHash}`);
          console.log(`[${clientId}] View on Etherscan: https://sepolia.etherscan.io/tx/${result.txHash}`);
        } else {
          console.log(`[${clientId}] Batch payment failed: ${result.error}`);
          console.log(`[${clientId}] (This is expected in simulation mode or if wallet has no funds)`);
        }
      }
    } catch (error) {
      console.log(`[${clientId}] Payment failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      console.log(`[${clientId}] (This is expected in simulation mode or if wallet has no funds)`);
    }
  } else if (client.pendingSettlements.length > 0) {
    console.log(`\n[${clientId}] Settlements queued for offline processing:`);
    for (const settlement of client.pendingSettlements) {
      console.log(`  - ${settlement.invoice?.amount} ETH to ${settlement.invoice?.recipient.slice(0, 10)}...`);
    }
  }

  return {
    totalTokens,
    expectedCost: (parseFloat(RATE_PER_TOKEN) * totalTokens).toFixed(6),
    transactions,
  };
}

async function main(): Promise<void> {
  console.log('=== Streaming Payments Example ===\n');
  console.log('This example demonstrates:');
  console.log('1. Authentication with ECDSA message signing');
  console.log('2. Wallet integration (Sepolia testnet)');
  console.log('3. Streaming payments (pay-per-token)');
  console.log('4. Batch settlements (aggregate invoices into single transaction)\n');

  const ethRpcUrl = process.env.RPC_URL;
  const walletRpcUrls: Record<number, string> = {};

  if (ethRpcUrl) {
    walletRpcUrls[ETH_SEPOLIA_CHAIN_ID] = ethRpcUrl;
    console.log(`Using RPC: ${ethRpcUrl.replace(/\/v2\/[^/]+$/, '/v2/***')}\n`);
  } else {
    console.log('No RPC_URL provided - running in simulation mode\n');
    console.log('To enable real transactions, run with:');
    console.log('  RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY bun run examples/streaming-payments.ts\n');
  }

  const serviceAgent = await createServiceAgent('streaming-service', walletRpcUrls);
  const clientAgent = await createClientAgent('streaming-client', walletRpcUrls);

  console.log('\nWaiting for peer discovery...\n');
  await delay(3000);

  await broadcastCapabilities(serviceAgent.node.ref);
  await broadcastCapabilities(clientAgent.node.ref);
  await delay(2000);

  const peers = await findPeers(clientAgent.node.ref, {
    requiredCapabilities: [
      {
        type: 'agent',
        name: 'streaming-text-generator',
      },
    ],
  });

  if (peers.length === 0) {
    console.error('Service agent not found!');
    await stop(serviceAgent.node.ref);
    await stop(clientAgent.node.ref);
    process.exit(1);
  }

  const servicePeer = peers[0].peer;
  console.log(`Found service peer: ${servicePeer.id}`);

  const jobResult = await startStreamingJob(clientAgent, servicePeer.id);

  console.log('\n=== Summary ===');
  console.log(`Service channels: ${serviceAgent.streamingChannels.size}`);
  console.log(`Client invoices received: ${clientAgent.receivedInvoices.length}`);

  let totalAccumulated = '0';
  for (const channel of serviceAgent.streamingChannels.values()) {
    totalAccumulated = (parseFloat(totalAccumulated) + parseFloat(channel.accumulatedAmount)).toFixed(6);
  }
  console.log(`Total accumulated: ${totalAccumulated} ETH`);

  console.log('\n=== Wallet Addresses ===');
  const serviceAddress = serviceAgent.wallet ? getAddress(serviceAgent.wallet) : 'N/A (simulation mode)';
  const clientAddress = clientAgent.wallet ? getAddress(clientAgent.wallet) : 'N/A (simulation mode)';
  console.log(`Service wallet: ${serviceAddress}`);
  console.log(`Client wallet:  ${clientAddress}`);

  if (serviceAgent.wallet) {
    console.log(`\nView service wallet: https://sepolia.etherscan.io/address/${serviceAddress}`);
    console.log(`View client wallet:  https://sepolia.etherscan.io/address/${clientAddress}`);
  }

  if (jobResult.transactions.length > 0) {
    console.log('\n=== Transactions ===');
    for (const tx of jobResult.transactions) {
      console.log(`Amount: ${tx.amount} ETH`);
      console.log(`Hash:   ${tx.txHash}`);
      console.log(`View:   https://sepolia.etherscan.io/tx/${tx.txHash}`);
    }
  }

  console.log('\n=== Shutting Down ===');
  await stop(serviceAgent.node.ref);
  console.log('[streaming-service] Stopped');
  await stop(clientAgent.node.ref);
  console.log('[streaming-client] Stopped');

  console.log('\nExample complete!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
