import {
  createInitialState,
  start,
  stop,
  subscribeToTopic,
  getId,
  findPeers,
  sendMessage,
  getState,
  type StateRef,
  type NodeState,
  PaymentProtocol,
  Wallet,
  setEscrowAgreement,
  updateEscrowAgreement,
  addPaymentLedgerEntry,
  enqueueSettlement,
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
): Promise<StateRef<NodeState>> {
  const agentState = createInitialState({
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

  const agentRef = await start(agentState);

  const walletAddress = await Wallet.getAddress(agentRef);
  console.log(`[${id}] Wallet address: ${walletAddress}\n`);

  const escrowAgreements = new Map<string, EscrowAgreement>();

  subscribeToTopic(agentRef, `peer:${getId(agentRef)}`, async (event) => {
    if (event.type !== 'message') return;

    const message = event.payload as Message;

    if (message.type === 'agent-request' && typeof message.payload === 'object' && message.payload !== null) {
      const payload = message.payload as Record<string, unknown>;
      if (payload.escrowAgreement && typeof payload.escrowAgreement === 'object') {
        const agreement = payload.escrowAgreement as EscrowAgreement;
        escrowAgreements.set(agreement.id, agreement);
        await setEscrowAgreement(agentRef, agreement);
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

        await updateEscrowAgreement(agentRef, approval.agreementId, () => updated);

        const milestone = updated.milestones.find((m) => m.id === approval.milestoneId);
        if (milestone) {
          const serviceWalletAddress = await Wallet.getAddress(agentRef);
          const invoice = PaymentProtocol.createInvoice(
            agreement.jobId,
            agreement.chainId,
            milestone.amount,
            agreement.token,
            serviceWalletAddress,
            Date.now() + 3600000
          );

          const invoiceMessage = PaymentProtocol.createInvoiceMessage(
            getId(agentRef),
            agreement.payer,
            invoice
          );

          await sendMessage(agentRef, agreement.payer, invoiceMessage);
          console.log(`[${id}] Sent invoice for milestone: ${milestone.amount} ETH`);
        }
      } else {
        console.log(`[${id}] Milestone ${approval.milestoneId} rejected`);
      }
    }
  });

  console.log(`[${id}] Service agent started on port ${port}`);
  return agentRef;
}

async function createClientAgent(
  id: string,
  port: number,
  registryUrl?: string,
  walletRpcUrls?: Record<number, string>
): Promise<StateRef<NodeState>> {
  const agentState = createInitialState({
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

  const agentRef = await start(agentState);

  const walletAddress = await Wallet.getAddress(agentRef);
  console.log(`[${id}] Wallet address: ${walletAddress}\n`);

  subscribeToTopic(agentRef, `peer:${getId(agentRef)}`, async (event) => {
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
        getId(agentRef),
        invoice.jobId
      );

      const settlementIntent = PaymentProtocol.createSettlementIntent(
        'escrow',
        ledgerEntry.id,
        invoice
      );

      await addPaymentLedgerEntry(agentRef, ledgerEntry);
      await enqueueSettlement(agentRef, settlementIntent);
      console.log(`[${id}] Settlement queued for invoice: ${invoice.id}`);
    }
  });

  console.log(`[${id}] Client agent started on port ${port}`);
  return agentRef;
}

async function createApproverAgent(
  id: string,
  port: number,
  registryUrl?: string,
  walletRpcUrls?: Record<number, string>
): Promise<StateRef<NodeState>> {
  const agentState = createInitialState({
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

  const agentRef = await start(agentState);

  subscribeToTopic(agentRef, `peer:${getId(agentRef)}`, async (event) => {
    if (event.type !== 'message') return;

    const message = event.payload as Message;

    if (PaymentProtocol.isEscrowApprovalMessage(message)) {
      console.log(`[${id}] Received approval request, forwarding to service agent...`);
      await sendMessage(agentRef, message.to, message);
      console.log(`[${id}] Approval forwarded to ${message.to}`);
    }
  });

  console.log(`[${id}] Approver agent started on port ${port}`);
  return agentRef;
}

async function startEscrowJob(
  clientRef: StateRef<NodeState>,
  servicePeerId: string,
  approverPeerId: string
): Promise<void> {
  console.log(`\n[${getId(clientRef)}] Starting escrow job`);
  console.log(`[${getId(clientRef)}] Service: ${servicePeerId}`);
  console.log(`[${getId(clientRef)}] Approver: ${approverPeerId}`);

  const payerId = getId(clientRef);
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

  console.log(`[${getId(clientRef)}] Created escrow agreement: ${escrowAgreement.id}`);
  console.log(`[${getId(clientRef)}] Total amount: ${totalAmount} ETH`);
  console.log(`[${getId(clientRef)}] Milestones: ${escrowAgreement.milestones.length}`);
  console.log(`[${getId(clientRef)}] Requires approval: ${escrowAgreement.requiresApproval}`);

  await setEscrowAgreement(clientRef, escrowAgreement);

  const agreementMessage: Message = {
    id: `agreement-${Date.now()}`,
    from: getId(clientRef),
    to: servicePeerId,
    type: 'agent-request',
    payload: { escrowAgreement },
    timestamp: Date.now(),
  };

  await sendMessage(clientRef, servicePeerId, agreementMessage);
  console.log(`[${getId(clientRef)}] Sent escrow agreement to service agent`);

  console.log(`\n[${getId(clientRef)}] Simulating work completion...`);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`[${getId(clientRef)}] Requesting approval for milestone 1...`);

  const milestone1 = escrowAgreement.milestones[0];
  const approvalMessage1 = PaymentProtocol.createEscrowApprovalMessage(
    approverPeerId,
    servicePeerId,
    escrowAgreement.id,
    milestone1.id,
    true
  );

  await sendMessage(clientRef, approverPeerId, approvalMessage1);
  console.log(`[${getId(clientRef)}] Approval request sent for milestone 1`);

  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`[${getId(clientRef)}] Requesting approval for milestone 2...`);

  const milestone2 = escrowAgreement.milestones[1];
  const approvalMessage2 = PaymentProtocol.createEscrowApprovalMessage(
    approverPeerId,
    servicePeerId,
    escrowAgreement.id,
    milestone2.id,
    true
  );

  await sendMessage(clientRef, approverPeerId, approvalMessage2);
  console.log(`[${getId(clientRef)}] Approval request sent for milestone 2`);

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const state = getState(clientRef);
  console.log(`\n[${getId(clientRef)}] Pending settlements: ${state.pendingSettlements.length}`);
  
  if (state.pendingSettlements.length > 0) {
    console.log(`[${getId(clientRef)}] Settlement details:`);
    for (const settlement of state.pendingSettlements) {
      console.log(`  - ID: ${settlement.id}, Invoice: ${settlement.invoice?.id}, Retry: ${settlement.retryCount}/${settlement.maxRetries}`);
    }
  }
  
  console.log(`[${getId(clientRef)}] Processing settlements...`);

  try {
    const processed = await Wallet.processSettlements(clientRef);
    console.log(`[${getId(clientRef)}] Processed ${processed} settlements`);
    
    await new Promise((resolve) => setTimeout(resolve, 500));
    
    const updatedState = getState(clientRef);
    
    const settledEntries = Object.values(updatedState.paymentLedger).filter(
      (entry) => entry.status === 'settled' && entry.txHash
    );
    
    if (settledEntries.length > 0) {
      console.log(`\n[${getId(clientRef)}] Transaction Details:`);
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
      console.log(`[${getId(clientRef)}] Remaining settlements: ${updatedState.pendingSettlements.length}`);
      for (const settlement of updatedState.pendingSettlements) {
        console.log(`  - ID: ${settlement.id}, Retry: ${settlement.retryCount}/${settlement.maxRetries}`);
      }
    }
  } catch (error) {
    console.error(`[${getId(clientRef)}] Error processing settlements:`, error instanceof Error ? error.message : String(error));
    console.error(`[${getId(clientRef)}] Full error:`, error);
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

  const serviceAgentRef = await createServiceAgent('escrow-service', 7791, registryUrl, walletRpcUrls);
  const clientAgentRef = await createClientAgent('escrow-client', 7792, registryUrl, walletRpcUrls);
  const approverAgentRef = await createApproverAgent('escrow-approver', 7793, registryUrl, walletRpcUrls);

  console.log('\nWaiting for peers to discover...\n');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const serviceMatches = await findPeers(clientAgentRef, {
    requiredCapabilities: [
      {
        type: 'agent',
        name: 'code-review-service',
      },
    ],
  });

  const approverMatches = await findPeers(clientAgentRef, {
    requiredCapabilities: [
      {
        type: 'agent',
        name: 'code-approver',
      },
    ],
  });

  if (serviceMatches.length === 0 || approverMatches.length === 0) {
    console.error('Required peers not found!');
    await stop(serviceAgentRef);
    await stop(clientAgentRef);
    await stop(approverAgentRef);
    return;
  }

  const servicePeer = serviceMatches[0].peer;
  const approverPeer = approverMatches[0].peer;

  console.log(`Found service peer: ${servicePeer.id}`);
  console.log(`Found approver peer: ${approverPeer.id}\n`);

  await startEscrowJob(clientAgentRef, servicePeer.id, approverPeer.id);

  await stop(serviceAgentRef);
  await stop(clientAgentRef);
  await stop(approverAgentRef);

  console.log('\n=== Example Complete ===');
}

main().catch(console.error);
