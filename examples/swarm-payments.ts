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
  createSwarmSplit,
  distributeSwarmSplit,
  writeSwarmSplit,
  updateSwarmSplit,
  writePaymentLedgerEntry,
  writeSettlement,
  storageInitialize,
  type EccoNode,
  type Message,
  type AuthState,
  type WalletState,
  type SwarmSplit,
  type Invoice,
  type PaymentLedgerEntry,
  type SettlementIntent,
} from '@ecco/core';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';

const ETH_SEPOLIA_CHAIN_ID = 11155111;

const CLIENT_KEY_PATH = '.keys/swarm-client-agent.json';
const WORKER1_KEY_PATH = '.keys/swarm-worker1-agent.json';
const WORKER2_KEY_PATH = '.keys/swarm-worker2-agent.json';
const WORKER3_KEY_PATH = '.keys/swarm-worker3-agent.json';

interface StoredKeys {
  algorithm: string;
  privateKey: string;
  publicKey: string;
  ethereumPrivateKey: `0x${string}`;
}

interface WorkerContribution {
  peerId: string;
  walletAddress: string;
  contribution: number;
  task: string;
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
  swarmSplits: Map<string, SwarmSplit>;
  receivedInvoices: Invoice[];
  pendingSettlements: SettlementIntent[];
  paymentLedger: PaymentLedgerEntry[];
  contributions: Map<string, WorkerContribution>;
}

function getKeyPathForWorker(name: string): string {
  if (name === 'swarm-worker1') return WORKER1_KEY_PATH;
  if (name === 'swarm-worker2') return WORKER2_KEY_PATH;
  return WORKER3_KEY_PATH;
}

async function createClientAgent(
  name: string,
  walletRpcUrls?: Record<number, string>
): Promise<AgentState> {
  console.log(`[${name}] Initializing client agent...`);

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

  const swarmSplits = new Map<string, SwarmSplit>();
  const receivedInvoices: Invoice[] = [];
  const pendingSettlements: SettlementIntent[] = [];
  const paymentLedger: PaymentLedgerEntry[] = [];
  const contributions = new Map<string, WorkerContribution>();

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

        if (message.type === 'agent-response') {
          const payload = message.payload as Record<string, unknown>;
          if (payload.contribution && typeof payload.contribution === 'number' && payload.task && payload.walletAddress) {
            const contribution: WorkerContribution = {
              peerId: message.from,
              walletAddress: payload.walletAddress as string,
              contribution: payload.contribution as number,
              task: payload.task as string,
            };
            contributions.set(message.from, contribution);
            console.log(`[${name}] Received contribution from ${message.from}: ${contribution.contribution} (${contribution.task})`);
          }
        }
      },
    }
  );

  console.log(`[${name}] Started with ID: ${node.id}`);

  return {
    node,
    auth,
    wallet,
    swarmSplits,
    receivedInvoices,
    pendingSettlements,
    paymentLedger,
    contributions,
  };
}

async function createWorkerAgent(
  name: string,
  task: string,
  contribution: number,
  walletRpcUrls?: Record<number, string>
): Promise<AgentState> {
  console.log(`\n[${name}] Initializing worker agent...`);

  await storageInitialize(name);

  const keyPath = getKeyPathForWorker(name);
  const keys = await loadOrCreateKeys(keyPath);
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

  console.log(`[${name}] Task: ${task}, Contribution weight: ${contribution}`);

  const receivedInvoices: Invoice[] = [];
  let nodeRef: EccoNode | null = null;

  const node = await ecco(
    {
      discovery: ['mdns', 'gossip'],
      nodeId: name,
      capabilities: [
        {
          type: 'agent',
          name: 'distributed-worker',
          version: '1.0.0',
          metadata: {
            task,
            contribution,
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

        if (message.type === 'agent-request') {
          const payload = message.payload as Record<string, unknown>;
          if (payload.jobId && payload.task === task) {
            console.log(`[${name}] Received job request for task: ${task}`);

            await delay(1000 + Math.random() * 2000);

            const walletAddress = wallet ? getAddress(wallet) : 'simulation-address';

            const response: Message = {
              id: crypto.randomUUID(),
              from: nodeRef?.id ?? name,
              to: message.from,
              type: 'agent-response',
              payload: {
                jobId: payload.jobId,
                task,
                contribution,
                walletAddress,
                completed: true,
              },
              timestamp: Date.now(),
            };

            const signedResponse = await signMessage(auth, response);
            if (nodeRef) {
              await sendMessage(nodeRef.ref, message.from, signedResponse);
              console.log(`[${name}] Sent contribution response: ${contribution}`);
            }
          }
        }

        if (message.type === 'invoice') {
          const invoice = message.payload as Invoice;
          receivedInvoices.push(invoice);
          console.log(`[${name}] Received invoice: ${invoice.amount} ${invoice.token}`);
          console.log(`[${name}] Invoice received - waiting for payment from client`);
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
    swarmSplits: new Map(),
    receivedInvoices,
    pendingSettlements: [],
    paymentLedger: [],
    contributions: new Map(),
  };
}

interface SwarmJobResult {
  splitId: string;
  totalAmount: string;
  participantCount: number;
  transactions: Array<{ amount: string; txHash: string }>;
}

async function startSwarmJob(
  client: AgentState,
  workerPeers: Array<{ peerId: string; libp2pPeerId: string; task: string; contribution: number }>,
  workers: AgentState[]
): Promise<SwarmJobResult> {
  const clientId = client.node.id;
  const clientLibp2pPeerId = getLibp2pPeerId(client.node.ref);

  console.log(`\n[${clientId}] Starting swarm job`);
  console.log(`[${clientId}] Workers: ${workerPeers.length}`);

  const jobId = `swarm-job-${Date.now()}`;
  const totalAmount = '0.003';

  console.log(`[${clientId}] Job ID: ${jobId}`);
  console.log(`[${clientId}] Total amount: ${totalAmount} ETH`);

  for (const worker of workerPeers) {
    const request: Message = {
      id: crypto.randomUUID(),
      from: clientLibp2pPeerId ?? clientId,
      to: worker.libp2pPeerId,
      type: 'agent-request',
      payload: {
        jobId,
        task: worker.task,
      },
      timestamp: Date.now(),
    };

    const signedRequest = await signMessage(client.auth, request);
    await sendMessage(client.node.ref, worker.libp2pPeerId, signedRequest);
    console.log(`[${clientId}] Sent job request to ${worker.peerId} for task: ${worker.task}`);
  }

  console.log(`\n[${clientId}] Waiting for contributions...`);
  await delay(5000);

  const workerWalletMap = new Map<string, string>();
  for (const worker of workers) {
    if (worker.wallet) {
      const libp2pId = getLibp2pPeerId(worker.node.ref);
      if (libp2pId) {
        workerWalletMap.set(libp2pId, getAddress(worker.wallet));
      }
    }
  }

  const participants: Array<{ peerId: string; walletAddress: string; contribution: number }> = [];

  for (const worker of workerPeers) {
    const walletAddr = workerWalletMap.get(worker.libp2pPeerId) ?? 'simulation-address';
    participants.push({
      peerId: worker.libp2pPeerId,
      walletAddress: walletAddr,
      contribution: worker.contribution,
    });
  }

  console.log(`\n[${clientId}] Creating swarm split...`);
  console.log(`[${clientId}] Contributions:`);
  const totalContribution = participants.reduce((sum, p) => sum + p.contribution, 0);
  for (const p of participants) {
    const percentage = ((p.contribution / totalContribution) * 100).toFixed(1);
    console.log(`  - ${p.peerId.slice(0, 16)}...: ${p.contribution} (${percentage}%) -> ${p.walletAddress.slice(0, 10)}...`);
  }

  const swarmSplit = createSwarmSplit(
    jobId,
    clientLibp2pPeerId ?? clientId,
    totalAmount,
    ETH_SEPOLIA_CHAIN_ID,
    'ETH',
    participants
  );

  client.swarmSplits.set(swarmSplit.id, swarmSplit);
  await writeSwarmSplit(swarmSplit);

  console.log(`\n[${clientId}] Swarm split created: ${swarmSplit.id}`);
  console.log(`[${clientId}] Participants: ${swarmSplit.participants.length}`);

  const distribution = distributeSwarmSplit(swarmSplit);

  console.log(`\n[${clientId}] Distribution amounts:`);
  for (let i = 0; i < distribution.invoices.length; i++) {
    const invoice = distribution.invoices[i];
    const participant = swarmSplit.participants[i];
    console.log(`  - ${participant.peerId.slice(0, 16)}...: ${invoice.amount} ETH (contribution: ${participant.contribution}) -> ${invoice.recipient.slice(0, 10)}...`);
  }

  client.swarmSplits.set(swarmSplit.id, distribution.split);
  await updateSwarmSplit(distribution.split);

  for (let i = 0; i < workerPeers.length; i++) {
    const worker = workerPeers[i];
    const invoice = distribution.invoices[i];

    if (invoice) {
      const invoiceMessage: Message = {
        id: crypto.randomUUID(),
        from: clientLibp2pPeerId ?? clientId,
        to: worker.libp2pPeerId,
        type: 'invoice',
        payload: invoice,
        timestamp: Date.now(),
      };

      const signedInvoice = await signMessage(client.auth, invoiceMessage);
      await sendMessage(client.node.ref, worker.libp2pPeerId, signedInvoice);
      console.log(`[${clientId}] Sent invoice to ${worker.peerId}: ${invoice.amount} ETH`);

      const ledgerEntry: PaymentLedgerEntry = {
        id: crypto.randomUUID(),
        type: 'swarm',
        status: 'pending',
        chainId: invoice.chainId,
        token: invoice.token,
        amount: invoice.amount,
        recipient: invoice.recipient,
        payer: clientId,
        jobId: invoice.jobId,
        createdAt: Date.now(),
      };
      client.paymentLedger.push(ledgerEntry);
      await writePaymentLedgerEntry(ledgerEntry);

      const settlement: SettlementIntent = {
        id: crypto.randomUUID(),
        type: 'swarm',
        ledgerEntryId: ledgerEntry.id,
        invoice,
        priority: 1,
        createdAt: Date.now(),
        retryCount: 0,
        maxRetries: 3,
      };
      client.pendingSettlements.push(settlement);
      await writeSettlement(settlement);
    }
  }

  await delay(2000);

  const transactions: Array<{ amount: string; txHash: string }> = [];

  if (client.wallet && client.pendingSettlements.length > 0) {
    console.log(`\n[${clientId}] Processing settlements...`);
    console.log(`[${clientId}] Pending settlements: ${client.pendingSettlements.length}`);

    const invoices = client.pendingSettlements
      .map((s) => s.invoice)
      .filter((inv): inv is Invoice => inv !== undefined);

    console.log(`[${clientId}] Settling ${invoices.length} invoices via batch payment...`);

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
    splitId: swarmSplit.id,
    totalAmount,
    participantCount: swarmSplit.participants.length,
    transactions,
  };
}

async function main(): Promise<void> {
  console.log('=== Swarm Payments Example ===\n');
  console.log('This example demonstrates:');
  console.log('1. Client distributes a job across multiple workers');
  console.log('2. Each worker contributes to the job');
  console.log('3. Client creates a swarm split based on contributions');
  console.log('4. Payments are distributed proportionally to each worker');
  console.log('5. Each worker receives an invoice for their share');
  console.log('6. Settlements are processed via batch payment\n');

  const ethRpcUrl = process.env.RPC_URL;
  const walletRpcUrls: Record<number, string> = {};

  if (ethRpcUrl) {
    walletRpcUrls[ETH_SEPOLIA_CHAIN_ID] = ethRpcUrl;
    console.log(`Using RPC: ${ethRpcUrl.replace(/\/v2\/[^/]+$/, '/v2/***')}\n`);
  } else {
    console.log('No RPC_URL provided - running in simulation mode\n');
    console.log('To enable real transactions, run with:');
    console.log('  RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY bun run examples/swarm-payments.ts\n');
  }

  const clientAgent = await createClientAgent('swarm-client', walletRpcUrls);
  const worker1Agent = await createWorkerAgent('swarm-worker1', 'data-processing', 40, walletRpcUrls);
  const worker2Agent = await createWorkerAgent('swarm-worker2', 'image-rendering', 35, walletRpcUrls);
  const worker3Agent = await createWorkerAgent('swarm-worker3', 'analysis', 25, walletRpcUrls);

  console.log('\nWaiting for peer discovery...\n');
  await delay(3000);

  await broadcastCapabilities(clientAgent.node.ref);
  await broadcastCapabilities(worker1Agent.node.ref);
  await broadcastCapabilities(worker2Agent.node.ref);
  await broadcastCapabilities(worker3Agent.node.ref);
  await delay(2000);

  const workerPeers = await findPeers(clientAgent.node.ref, {
    requiredCapabilities: [
      {
        type: 'agent',
        name: 'distributed-worker',
      },
    ],
  });

  if (workerPeers.length === 0) {
    console.error('No worker peers found!');
    await stop(clientAgent.node.ref);
    await stop(worker1Agent.node.ref);
    await stop(worker2Agent.node.ref);
    await stop(worker3Agent.node.ref);
    process.exit(1);
  }

  console.log(`Found ${workerPeers.length} worker peers:`);

  const workers = [worker1Agent, worker2Agent, worker3Agent];
  const tasks = ['data-processing', 'image-rendering', 'analysis'];
  const contributions = [40, 35, 25];

  const workerPeerData: Array<{ peerId: string; libp2pPeerId: string; task: string; contribution: number }> = [];

  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];
    const libp2pPeerId = getLibp2pPeerId(worker.node.ref);
    if (libp2pPeerId) {
      workerPeerData.push({
        peerId: worker.node.id,
        libp2pPeerId,
        task: tasks[i],
        contribution: contributions[i],
      });
      console.log(`  - ${worker.node.id}: ${tasks[i]} (contribution: ${contributions[i]})`);
    }
  }

  console.log('');

  const jobResult = await startSwarmJob(clientAgent, workerPeerData, workers);

  console.log('\n=== Summary ===');
  console.log(`Swarm Split ID: ${jobResult.splitId}`);
  console.log(`Total amount: ${jobResult.totalAmount} ETH`);
  console.log(`Participants: ${jobResult.participantCount}`);
  console.log(`Client swarm splits: ${clientAgent.swarmSplits.size}`);

  console.log('\n=== Wallet Addresses ===');
  const clientAddress = clientAgent.wallet ? getAddress(clientAgent.wallet) : 'N/A (simulation mode)';
  const worker1Address = worker1Agent.wallet ? getAddress(worker1Agent.wallet) : 'N/A (simulation mode)';
  const worker2Address = worker2Agent.wallet ? getAddress(worker2Agent.wallet) : 'N/A (simulation mode)';
  const worker3Address = worker3Agent.wallet ? getAddress(worker3Agent.wallet) : 'N/A (simulation mode)';
  console.log(`Client wallet:  ${clientAddress}`);
  console.log(`Worker 1 wallet: ${worker1Address}`);
  console.log(`Worker 2 wallet: ${worker2Address}`);
  console.log(`Worker 3 wallet: ${worker3Address}`);

  if (clientAgent.wallet) {
    console.log(`\nView client wallet: https://sepolia.etherscan.io/address/${clientAddress}`);
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
  await stop(clientAgent.node.ref);
  console.log('[swarm-client] Stopped');
  await stop(worker1Agent.node.ref);
  console.log('[swarm-worker1] Stopped');
  await stop(worker2Agent.node.ref);
  console.log('[swarm-worker2] Stopped');
  await stop(worker3Agent.node.ref);
  console.log('[swarm-worker3] Stopped');

  console.log('\nExample complete!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
