import {
  Node,
  type NodeState,
  PaymentProtocol,
  Wallet,
  setSwarmSplit,
  updateSwarmSplit,
  addPaymentLedgerEntry,
  enqueueSettlement,
  getNodeState,
} from '@ecco/core';
import type { SwarmSplit, Invoice, Message } from '@ecco/core';

const ETH_SEPOLIA_CHAIN_ID = 11155111;

const CLIENT_KEY_PATH = '.keys/client-agent.json';
const WORKER1_KEY_PATH = '.keys/swarm-worker1-agent.json';
const WORKER2_KEY_PATH = '.keys/swarm-worker2-agent.json';
const WORKER3_KEY_PATH = '.keys/swarm-worker3-agent.json';

interface WorkerContribution {
  peerId: string;
  walletAddress: string;
  contribution: number;
  task: string;
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

  const workerContributions = new Map<string, WorkerContribution>();
  const receivedInvoices: Invoice[] = [];

  Node.subscribeToTopic(agent, `peer:${Node.getId(agent)}`, async (event) => {
    if (event.type !== 'message') return;

    const message = event.payload as Message;

    if (message.type === 'agent-response' && typeof message.payload === 'object' && message.payload !== null) {
      const payload = message.payload as Record<string, unknown>;
      if (payload.contribution && typeof payload.contribution === 'number' && payload.task && payload.walletAddress) {
        const contribution: WorkerContribution = {
          peerId: message.from,
          walletAddress: payload.walletAddress as string,
          contribution: payload.contribution as number,
          task: payload.task as string,
        };
        workerContributions.set(message.from, contribution);
        console.log(`[${id}] Received contribution from ${message.from}: ${contribution.contribution} (${contribution.task})`);
      }
    }

    if (PaymentProtocol.isInvoiceMessage(message)) {
      const invoice = message.payload as Invoice;
      receivedInvoices.push(invoice);
      console.log(`[${id}] Received invoice: ${invoice.amount} ${invoice.token}`);

      const ledgerEntry = PaymentProtocol.createPaymentLedgerEntry(
        'swarm',
        invoice.chainId,
        invoice.token,
        invoice.amount,
        invoice.recipient,
        Node.getId(agent),
        invoice.jobId
      );

      const settlementIntent = PaymentProtocol.createSettlementIntent(
        'swarm',
        ledgerEntry.id,
        invoice
      );

      if (agent._ref) {
        await addPaymentLedgerEntry(agent._ref, ledgerEntry);
        await enqueueSettlement(agent._ref, settlementIntent);
        console.log(`[${id}] Settlement queued for invoice: ${invoice.id}`);
      }
    }
  });

  console.log(`[${id}] Client agent started on port ${port}`);
  return agent;
}

async function createWorkerAgent(
  id: string,
  port: number,
  task: string,
  contribution: number,
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
      keyPath: id === 'swarm-worker1' ? WORKER1_KEY_PATH : id === 'swarm-worker2' ? WORKER2_KEY_PATH : WORKER3_KEY_PATH,
      walletRpcUrls,
    },
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
      websocket: { enabled: true, port },
    },
  });

  let agent = await Node.start(agentState);

  const walletAddress = await Wallet.getAddress(agent);
  console.log(`[${id}] Wallet address: ${walletAddress}`);
  console.log(`[${id}] Task: ${task}, Contribution: ${contribution}\n`);

  Node.subscribeToTopic(agent, `peer:${Node.getId(agent)}`, async (event) => {
    if (event.type !== 'message') return;

    const message = event.payload as Message;

    if (message.type === 'agent-request' && typeof message.payload === 'object' && message.payload !== null) {
      const payload = message.payload as Record<string, unknown>;
      if (payload.jobId && payload.task === task) {
        console.log(`[${id}] Received job request for task: ${task}`);
        
        await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 2000));

        const response: Message = {
          id: `response-${Date.now()}`,
          from: Node.getId(agent),
          to: event.from,
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

        await Node.sendMessage(agent, event.from, response);
        console.log(`[${id}] Sent contribution response: ${contribution}`);
      }
    }

    if (PaymentProtocol.isInvoiceMessage(message)) {
      const invoice = message.payload as Invoice;
      
      if (invoice.recipient === walletAddress) {
        console.log(`[${id}] Received invoice: ${invoice.amount} ${invoice.token}`);
        console.log(`[${id}] Invoice received - waiting for payment from client`);
      }
    }
  });

  console.log(`[${id}] Worker agent started on port ${port}`);
  return agent;
}

async function startSwarmJob(
  clientAgent: NodeState,
  workerPeers: Array<{ peer: { id: string; addresses?: string[]; capabilities?: unknown[]; lastSeen?: number }; contribution: number; task: string }>,
  workerAgents: NodeState[]
): Promise<void> {
  console.log(`\n[${Node.getId(clientAgent)}] Starting swarm job`);
  console.log(`[${Node.getId(clientAgent)}] Workers: ${workerPeers.length}`);

  const payerId = Node.getId(clientAgent);
  const jobId = `swarm-job-${Date.now()}`;
  const totalAmount = '0.003';

  console.log(`[${Node.getId(clientAgent)}] Job ID: ${jobId}`);
  console.log(`[${Node.getId(clientAgent)}] Total amount: ${totalAmount} ETH`);

  for (const worker of workerPeers) {
    const request: Message = {
      id: `request-${Date.now()}-${worker.peer.id}`,
      from: payerId,
      to: worker.peer.id,
      type: 'agent-request',
      payload: {
        jobId,
        task: worker.task,
      },
      timestamp: Date.now(),
    };

    await Node.sendMessage(clientAgent, worker.peer.id, request);
    console.log(`[${Node.getId(clientAgent)}] Sent job request to ${worker.peer.id} for task: ${worker.task}`);
  }

  console.log(`\n[${Node.getId(clientAgent)}] Waiting for contributions...`);
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const workerWalletMap = new Map<string, string>();
  for (const worker of workerPeers) {
    try {
      const workerNode = workerAgents.find(agent => Node.getId(agent) === worker.peer.id);
      if (workerNode) {
        const walletAddr = await Wallet.getAddress(workerNode);
        workerWalletMap.set(worker.peer.id, walletAddr);
        console.log(`[${Node.getId(clientAgent)}] Got wallet address for ${worker.peer.id}: ${walletAddr}`);
      }
    } catch (error) {
      console.error(`[${Node.getId(clientAgent)}] Failed to get wallet address for ${worker.peer.id}:`, error);
    }
  }

  if (clientAgent._ref) {
    const contributions: Array<{ peerId: string; walletAddress: string; contribution: number }> = [];

    for (const worker of workerPeers) {
      const walletAddr = workerWalletMap.get(worker.peer.id);
      if (!walletAddr) {
        console.error(`[${Node.getId(clientAgent)}] Missing wallet address for ${worker.peer.id}`);
        continue;
      }
      contributions.push({
        peerId: worker.peer.id,
        walletAddress: walletAddr,
        contribution: worker.contribution,
      });
    }

    console.log(`\n[${Node.getId(clientAgent)}] Creating swarm split...`);
    console.log(`[${Node.getId(clientAgent)}] Contributions:`);
    const totalContribution = contributions.reduce((sum, c) => sum + c.contribution, 0);
    for (const c of contributions) {
      const percentage = ((c.contribution / totalContribution) * 100).toFixed(1);
      console.log(`  - ${c.peerId}: ${c.contribution} (${percentage}%) -> ${c.walletAddress}`);
    }

    const swarmSplit = PaymentProtocol.createSwarmSplit(
      jobId,
      payerId,
      totalAmount,
      ETH_SEPOLIA_CHAIN_ID,
      'ETH',
      contributions
    );

    if (clientAgent._ref) {
      await setSwarmSplit(clientAgent._ref, swarmSplit);
    }

    console.log(`\n[${Node.getId(clientAgent)}] Swarm split created: ${swarmSplit.id}`);
    console.log(`[${Node.getId(clientAgent)}] Participants: ${swarmSplit.participants.length}`);

    const distribution = PaymentProtocol.distributeSwarmSplit(swarmSplit);

    console.log(`\n[${Node.getId(clientAgent)}] Distribution amounts:`);
    for (let i = 0; i < distribution.invoices.length; i++) {
      const invoice = distribution.invoices[i];
      const participant = swarmSplit.participants[i];
      console.log(`  - ${participant.peerId}: ${invoice.amount} ETH (contribution: ${participant.contribution}) -> ${invoice.recipient}`);
    }

    if (clientAgent._ref) {
      await updateSwarmSplit(clientAgent._ref, swarmSplit.id, () => distribution.split);
    }

    for (let i = 0; i < workerPeers.length; i++) {
      const worker = workerPeers[i];
      const invoice = distribution.invoices[i];
      const walletAddr = workerWalletMap.get(worker.peer.id);
      
      if (invoice && walletAddr && invoice.recipient === walletAddr) {
        const invoiceMessage = PaymentProtocol.createInvoiceMessage(
          Node.getId(clientAgent),
          worker.peer.id,
          invoice
        );

        await Node.sendMessage(clientAgent, worker.peer.id, invoiceMessage);
        console.log(`[${Node.getId(clientAgent)}] Sent invoice to ${worker.peer.id}: ${invoice.amount} ETH`);

        const ledgerEntry = PaymentProtocol.createPaymentLedgerEntry(
          'swarm',
          invoice.chainId,
          invoice.token,
          invoice.amount,
          invoice.recipient,
          Node.getId(clientAgent),
          invoice.jobId
        );

        const settlementIntent = PaymentProtocol.createSettlementIntent(
          'swarm',
          ledgerEntry.id,
          invoice
        );

        if (clientAgent._ref) {
          await addPaymentLedgerEntry(clientAgent._ref, ledgerEntry);
          await enqueueSettlement(clientAgent._ref, settlementIntent);
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));

    console.log(`\n[${Node.getId(clientAgent)}] Processing settlements to pay workers...`);

    try {
      const processed = await Wallet.processSettlements(clientAgent);
      console.log(`[${Node.getId(clientAgent)}] Processed ${processed} settlements`);

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const updatedState = await getNodeState(clientAgent._ref);

      const settledEntries = Array.from(updatedState.paymentLedger.values()).filter(
        (entry) => entry.status === 'settled' && entry.txHash
      );

      if (settledEntries.length > 0) {
        console.log(`\n[${Node.getId(clientAgent)}] Transaction Details:`);
        for (const entry of settledEntries) {
          const chainId = entry.chainId;
          const txHash = entry.txHash!;
          let etherscanUrl: string;

          if (chainId === 11155111) {
            etherscanUrl = `https://sepolia.etherscan.io/tx/${txHash}`;
          } else if (chainId === 84532) {
            etherscanUrl = `https://sepolia.basescan.org/tx/${txHash}`;
          } else {
            etherscanUrl = `https://etherscan.io/tx/${txHash}`;
          }

          console.log(`  - Amount: ${entry.amount} ${entry.token}`);
          console.log(`  - Recipient: ${entry.recipient}`);
          console.log(`  - TX Hash: ${txHash}`);
          console.log(`  - View on Etherscan: ${etherscanUrl}`);
          console.log('');
        }
      }

      if (updatedState.pendingSettlements.length > 0) {
        console.log(`[${Node.getId(clientAgent)}] Remaining settlements: ${updatedState.pendingSettlements.length}`);
        for (const settlement of updatedState.pendingSettlements) {
          console.log(`  - ID: ${settlement.id}, Retry: ${settlement.retryCount}/${settlement.maxRetries}`);
        }
      }
    } catch (error) {
      console.error(`[${Node.getId(clientAgent)}] Error processing settlements:`, error instanceof Error ? error.message : String(error));
    }
  }
}

async function main() {
  console.log('=== Swarm Payments Example ===\n');
  console.log('This example demonstrates:');
  console.log('1. Client distributes a job across multiple workers');
  console.log('2. Each worker contributes to the job');
  console.log('3. Client creates a swarm split based on contributions');
  console.log('4. Payments are distributed proportionally to each worker');
  console.log('5. Each worker receives an invoice for their share');
  console.log('6. Settlements are processed when online\n');

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

  const clientAgent = await createClientAgent('swarm-client', 7771, registryUrl, walletRpcUrls);
  const worker1Agent = await createWorkerAgent('swarm-worker1', 7772, 'data-processing', 40, registryUrl, walletRpcUrls);
  const worker2Agent = await createWorkerAgent('swarm-worker2', 7773, 'image-rendering', 35, registryUrl, walletRpcUrls);
  const worker3Agent = await createWorkerAgent('swarm-worker3', 7774, 'analysis', 25, registryUrl, walletRpcUrls);

  console.log('\nWaiting for peers to discover...\n');
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const workerAgents = [worker1Agent, worker2Agent, worker3Agent];
  const tasks = ['data-processing', 'image-rendering', 'analysis'];
  const contributions = [40, 35, 25];

  let matches: Array<{ peer: { id: string }; matchScore: number; matchedCapabilities: unknown[] }> = [];
  let attempts = 0;
  const maxAttempts = 15;

  while (matches.length < 3 && attempts < maxAttempts) {
    const result = await Node.findPeers(clientAgent, {
      requiredCapabilities: [
        {
          type: 'agent',
          name: 'distributed-worker',
        },
      ],
    });
    matches = result.matches;
    
    if (matches.length < 3) {
      attempts++;
      console.log(`Found ${matches.length} workers, waiting for more... (attempt ${attempts}/${maxAttempts})`);
      
      const foundWorkerIds = new Set(matches.map(m => m.peer.id));
      const expectedWorkerIds = workerAgents.map(a => Node.getId(a));
      const missingWorkers = expectedWorkerIds.filter(id => !foundWorkerIds.has(id));
      
      if (missingWorkers.length > 0) {
        console.log(`Missing workers: ${missingWorkers.join(', ')}`);
      }
      
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  const foundWorkerIds = new Set(matches.map(m => m.peer.id));
  const expectedWorkerIds = workerAgents.map(a => Node.getId(a));
  const missingWorkers = expectedWorkerIds.filter(id => !foundWorkerIds.has(id));

  let workerPeers: Array<{ peer: { id: string }; contribution: number; task: string }>;

  if (matches.length < 3) {
    console.warn(`\nWarning: Only found ${matches.length} workers via discovery. Using fallback: creating peer info directly from worker agents.`);
    console.log('Available peers from discovery:');
    for (const match of matches) {
      console.log(`  - ${match.peer.id}`);
    }
    if (missingWorkers.length > 0) {
      console.log(`\nMissing workers from discovery: ${missingWorkers.join(', ')}`);
      console.log('Using direct worker references as fallback...\n');
    }

    workerPeers = workerAgents.map((agent, index) => {
      const agentId = Node.getId(agent);
      return {
        peer: { id: agentId },
        contribution: contributions[index],
        task: tasks[index],
      };
    });
  } else {
    workerPeers = workerAgents.map((agent, index) => {
      const match = matches.find(m => m.peer.id === Node.getId(agent));
      if (!match) {
        throw new Error(`Worker ${Node.getId(agent)} not found in matches`);
      }
      return {
        peer: match.peer,
        contribution: contributions[index],
        task: tasks[index],
      };
    });
  }

  console.log(`Found ${workerPeers.length} worker peers:`);
  for (const worker of workerPeers) {
    console.log(`  - ${worker.peer.id}: ${worker.task} (contribution: ${worker.contribution})`);
  }
  console.log('');

  await startSwarmJob(clientAgent, workerPeers, [worker1Agent, worker2Agent, worker3Agent]);

  await Node.stop(clientAgent);
  await Node.stop(worker1Agent);
  await Node.stop(worker2Agent);
  await Node.stop(worker3Agent);

  console.log('\n=== Example Complete ===');
}

main().catch(console.error);

