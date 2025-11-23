import {
  Node,
  type NodeState,
  PaymentProtocol,
  Wallet,
  EventBus,
  type EccoEvent,
  setEscrowAgreement,
  updateEscrowAgreement,
  addPaymentLedgerEntry,
  enqueueSettlement,
  getNodeState,
} from '@ecco/core';
import type { EscrowAgreement, Invoice, Message } from '@ecco/core';

const ETH_SEPOLIA_CHAIN_ID = 11155111;

const SERVICE_KEY_PATH = '.keys/escrow-service-agent.json';
const CLIENT_KEY_PATH = '.keys/client-agent.json';
const APPROVER_KEY_PATH = '.keys/escrow-approver-agent.json';

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
        name: 'code-review-service',
        version: '1.0.0',
        metadata: {
          escrowEnabled: true,
        },
      },
    ],
    transport: {
      websocket: { enabled: true, port },
    },
  });

  let agent = await Node.start(agentState);

  const walletAddress = await Wallet.getAddress(agent);
  console.log(`[${id}] Wallet address: ${walletAddress}\n`);

  const escrowAgreements = new Map<string, EscrowAgreement>();

  Node.subscribeToTopic(agent, `peer:${Node.getId(agent)}`, async (event) => {
    if (event.type !== 'message') return;

    const message = event.payload as Message;

    if (message.type === 'agent-request' && typeof message.payload === 'object' && message.payload !== null) {
      const payload = message.payload as Record<string, unknown>;
      if (payload.escrowAgreement && typeof payload.escrowAgreement === 'object') {
        const agreement = payload.escrowAgreement as EscrowAgreement;
        escrowAgreements.set(agreement.id, agreement);
        if (agent._ref) {
          await setEscrowAgreement(agent._ref, agreement);
        }
        console.log(`[${id}] Received escrow agreement: ${agreement.id}`);
        return;
      }
    }

    if (PaymentProtocol.isEscrowApprovalMessage(message)) {
      const approval = message.payload as {
        agreementId: string;
        milestoneId: string;
        approved: boolean;
        timestamp: number;
      };

      const agreement = escrowAgreements.get(approval.agreementId);
      if (!agreement) {
        console.log(`[${id}] Unknown escrow agreement: ${approval.agreementId}`);
        return;
      }

      if (approval.approved) {
        console.log(`[${id}] Milestone ${approval.milestoneId} approved, releasing...`);

        const updated = PaymentProtocol.releaseEscrowMilestone(agreement, approval.milestoneId);
        escrowAgreements.set(approval.agreementId, updated);

        if (agent._ref) {
          await updateEscrowAgreement(agent._ref, approval.agreementId, () => updated);
        }

        const milestone = updated.milestones.find((m) => m.id === approval.milestoneId);
        if (milestone) {
          const serviceWalletAddress = await Wallet.getAddress(agent);
          const invoice = PaymentProtocol.createInvoice(
            agreement.jobId,
            agreement.chainId,
            milestone.amount,
            agreement.token,
            serviceWalletAddress,
            Date.now() + 3600000
          );

          const invoiceMessage = PaymentProtocol.createInvoiceMessage(
            Node.getId(agent),
            agreement.payer,
            invoice
          );

          await Node.sendMessage(agent, agreement.payer, invoiceMessage);
          console.log(`[${id}] Sent invoice for milestone: ${milestone.amount} ETH`);
        }
      } else {
        console.log(`[${id}] Milestone ${approval.milestoneId} rejected`);
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

  Node.subscribeToTopic(agent, `peer:${Node.getId(agent)}`, async (event) => {
    if (event.type !== 'message') return;

    const message = event.payload as Message;

    if (PaymentProtocol.isInvoiceMessage(message)) {
      const invoice = message.payload as Invoice;
      console.log(`[${id}] Received invoice: ${invoice.id} for ${invoice.amount} ${invoice.token}`);

      const ledgerEntry = PaymentProtocol.createPaymentLedgerEntry(
        'escrow',
        invoice.chainId,
        invoice.token,
        invoice.amount,
        invoice.recipient,
        Node.getId(agent),
        invoice.jobId
      );

      const settlementIntent = PaymentProtocol.createSettlementIntent(
        'escrow',
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

async function createApproverAgent(
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
      keyPath: APPROVER_KEY_PATH,
      walletRpcUrls,
    },
    capabilities: [
      {
        type: 'agent',
        name: 'code-approver',
        version: '1.0.0',
      },
    ],
    transport: {
      websocket: { enabled: true, port },
    },
  });

  let agent = await Node.start(agentState);

  Node.subscribeToTopic(agent, `peer:${Node.getId(agent)}`, async (event) => {
    if (event.type !== 'message') return;

    const message = event.payload as Message;

    if (PaymentProtocol.isEscrowApprovalMessage(message)) {
      console.log(`[${id}] Received approval request, forwarding to service agent...`);
      await Node.sendMessage(agent, message.to, message);
      console.log(`[${id}] Approval forwarded to ${message.to}`);
    }
  });

  console.log(`[${id}] Approver agent started on port ${port}`);
  return agent;
}

async function startEscrowJob(
  clientAgent: NodeState,
  servicePeerId: string,
  approverPeerId: string
): Promise<void> {
  console.log(`\n[${Node.getId(clientAgent)}] Starting escrow job`);
  console.log(`[${Node.getId(clientAgent)}] Service: ${servicePeerId}`);
  console.log(`[${Node.getId(clientAgent)}] Approver: ${approverPeerId}`);

  const payerId = Node.getId(clientAgent);
  const recipientId = servicePeerId;
  const jobId = `escrow-job-${Date.now()}`;
  const totalAmount = '0.001';

  const escrowAgreement = PaymentProtocol.createEscrowAgreement(
    jobId,
    payerId,
    recipientId,
    ETH_SEPOLIA_CHAIN_ID,
    'ETH',
    totalAmount,
    [
      { amount: '0.0005' },
      { amount: '0.0005' },
    ],
    true,
    approverPeerId
  );

  console.log(`[${Node.getId(clientAgent)}] Created escrow agreement: ${escrowAgreement.id}`);
  console.log(`[${Node.getId(clientAgent)}] Total amount: ${totalAmount} ETH`);
  console.log(`[${Node.getId(clientAgent)}] Milestones: ${escrowAgreement.milestones.length}`);
  console.log(`[${Node.getId(clientAgent)}] Requires approval: ${escrowAgreement.requiresApproval}`);

  if (clientAgent._ref) {
    await setEscrowAgreement(clientAgent._ref, escrowAgreement);
  }

  const agreementMessage: Message = {
    id: `agreement-${Date.now()}`,
    from: Node.getId(clientAgent),
    to: servicePeerId,
    type: 'agent-request',
    payload: { escrowAgreement },
    timestamp: Date.now(),
  };

  await Node.sendMessage(clientAgent, servicePeerId, agreementMessage);
  console.log(`[${Node.getId(clientAgent)}] Sent escrow agreement to service agent`);

  console.log(`\n[${Node.getId(clientAgent)}] Simulating work completion...`);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`[${Node.getId(clientAgent)}] Requesting approval for milestone 1...`);

  const milestone1 = escrowAgreement.milestones[0];
  const approvalMessage1 = PaymentProtocol.createEscrowApprovalMessage(
    approverPeerId,
    servicePeerId,
    escrowAgreement.id,
    milestone1.id,
    true
  );

  await Node.sendMessage(clientAgent, approverPeerId, approvalMessage1);
  console.log(`[${Node.getId(clientAgent)}] Approval request sent for milestone 1`);

  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`[${Node.getId(clientAgent)}] Requesting approval for milestone 2...`);

  const milestone2 = escrowAgreement.milestones[1];
  const approvalMessage2 = PaymentProtocol.createEscrowApprovalMessage(
    approverPeerId,
    servicePeerId,
    escrowAgreement.id,
    milestone2.id,
    true
  );

  await Node.sendMessage(clientAgent, approverPeerId, approvalMessage2);
  console.log(`[${Node.getId(clientAgent)}] Approval request sent for milestone 2`);

  await new Promise((resolve) => setTimeout(resolve, 3000));

  if (clientAgent._ref) {
    const state = await getNodeState(clientAgent._ref);
    console.log(`\n[${Node.getId(clientAgent)}] Pending settlements: ${state.pendingSettlements.length}`);
    
    if (state.pendingSettlements.length > 0) {
      console.log(`[${Node.getId(clientAgent)}] Settlement details:`);
      for (const settlement of state.pendingSettlements) {
        console.log(`  - ID: ${settlement.id}, Invoice: ${settlement.invoice?.id}, Retry: ${settlement.retryCount}/${settlement.maxRetries}`);
      }
    }
    
    console.log(`[${Node.getId(clientAgent)}] Processing settlements...`);

    try {
      const processed = await Wallet.processSettlements(clientAgent);
      console.log(`[${Node.getId(clientAgent)}] Processed ${processed} settlements`);
      
      await new Promise((resolve) => setTimeout(resolve, 500));
      
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
      console.error(`[${Node.getId(clientAgent)}] Full error:`, error);
    }
  }
}

async function main() {
  console.log('=== Escrow Payments Example ===\n');
  console.log('This example demonstrates:');
  console.log('1. Client creates escrow agreement with milestones (50/50 split)');
  console.log('2. Service completes work in milestones');
  console.log('3. Approver approves each milestone');
  console.log('4. Payments are released per milestone');
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

  const serviceAgent = await createServiceAgent('escrow-service', 7791, registryUrl, walletRpcUrls);
  const clientAgent = await createClientAgent('escrow-client', 7792, registryUrl, walletRpcUrls);
  const approverAgent = await createApproverAgent('escrow-approver', 7793, registryUrl, walletRpcUrls);

  console.log('\nWaiting for peers to discover...\n');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const { matches: serviceMatches } = await Node.findPeers(clientAgent, {
    requiredCapabilities: [
      {
        type: 'agent',
        name: 'code-review-service',
      },
    ],
  });

  const { matches: approverMatches } = await Node.findPeers(clientAgent, {
    requiredCapabilities: [
      {
        type: 'agent',
        name: 'code-approver',
      },
    ],
  });

  if (serviceMatches.length === 0 || approverMatches.length === 0) {
    console.error('Required peers not found!');
    await Node.stop(serviceAgent);
    await Node.stop(clientAgent);
    await Node.stop(approverAgent);
    return;
  }

  const servicePeer = serviceMatches[0].peer;
  const approverPeer = approverMatches[0].peer;

  console.log(`Found service peer: ${servicePeer.id}`);
  console.log(`Found approver peer: ${approverPeer.id}\n`);

  await startEscrowJob(clientAgent, servicePeer.id, approverPeer.id);

  await Node.stop(serviceAgent);
  await Node.stop(clientAgent);
  await Node.stop(approverAgent);

  console.log('\n=== Example Complete ===');
}

main().catch(console.error);

