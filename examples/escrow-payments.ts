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
  releaseEscrowMilestone,
  writeEscrowAgreement,
  updateEscrowAgreement,
  writePaymentLedgerEntry,
  writeSettlement,
  storageInitialize,
  type EccoNode,
  type Message,
  type AuthState,
  type WalletState,
  type EscrowAgreement,
  type EscrowMilestone,
  type Invoice,
  type PaymentLedgerEntry,
  type SettlementIntent,
} from '@ecco/core';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';

const ETH_SEPOLIA_CHAIN_ID = 11155111;

const SERVICE_KEY_PATH = '.keys/escrow-service-agent.json';
const CLIENT_KEY_PATH = '.keys/escrow-client-agent.json';
const APPROVER_KEY_PATH = '.keys/escrow-approver-agent.json';

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

function createEscrowAgreement(
  jobId: string,
  payer: string,
  recipient: string,
  chainId: number,
  token: string,
  totalAmount: string,
  milestoneAmounts: string[],
  requiresApproval: boolean,
  approver?: string
): EscrowAgreement {
  const milestones: EscrowMilestone[] = milestoneAmounts.map((amount) => ({
    id: crypto.randomUUID(),
    amount,
    released: false,
  }));

  return {
    id: crypto.randomUUID(),
    jobId,
    payer,
    recipient,
    chainId,
    token,
    totalAmount,
    milestones,
    status: 'locked',
    createdAt: Date.now(),
    requiresApproval,
    approver,
  };
}

interface AgentState {
  node: EccoNode;
  auth: AuthState;
  wallet: WalletState | null;
  escrowAgreements: Map<string, EscrowAgreement>;
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

  const escrowAgreements = new Map<string, EscrowAgreement>();
  const clientPeerIds = new Map<string, string>();
  let nodeRef: EccoNode | null = null;

  const node = await ecco(
    {
      discovery: ['mdns', 'gossip'],
      nodeId: name,
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
          if (payload.escrowAgreement && typeof payload.escrowAgreement === 'object') {
            const agreement = payload.escrowAgreement as EscrowAgreement;
            escrowAgreements.set(agreement.id, agreement);
            if (typeof payload.clientPeerId === 'string') {
              clientPeerIds.set(agreement.id, payload.clientPeerId);
            }
            await writeEscrowAgreement(agreement);
            console.log(`[${name}] Received escrow agreement: ${agreement.id}`);
            console.log(`[${name}] Total amount: ${agreement.totalAmount} ${agreement.token}`);
            console.log(`[${name}] Milestones: ${agreement.milestones.length}`);
          }
        }

        if (message.type === 'escrow-approval') {
          const approval = message.payload as {
            agreementId: string;
            milestoneId: string;
            approved: boolean;
            timestamp: number;
          };

          const agreement = escrowAgreements.get(approval.agreementId);
          if (!agreement) {
            console.log(`[${name}] Unknown escrow agreement: ${approval.agreementId}`);
            return;
          }

          if (approval.approved) {
            console.log(`[${name}] Milestone ${approval.milestoneId} approved, releasing...`);

            const updated = releaseEscrowMilestone(agreement, approval.milestoneId);
            escrowAgreements.set(approval.agreementId, updated);
            await updateEscrowAgreement(updated);

            const milestone = updated.milestones.find((m) => m.id === approval.milestoneId);
            const payerPeerId = clientPeerIds.get(approval.agreementId);
            if (milestone && nodeRef && wallet && payerPeerId) {
              const serviceWalletAddress = getAddress(wallet);
              const invoice: Invoice = {
                id: crypto.randomUUID(),
                jobId: agreement.jobId,
                chainId: agreement.chainId,
                amount: milestone.amount,
                token: agreement.token,
                recipient: serviceWalletAddress,
                validUntil: Date.now() + 3600000,
              };

              const invoiceMessage: Message = {
                id: crypto.randomUUID(),
                from: nodeRef.id,
                to: payerPeerId,
                type: 'invoice',
                payload: invoice,
                timestamp: Date.now(),
              };

              const signedInvoice = await signMessage(auth, invoiceMessage);
              await sendMessage(nodeRef.ref, payerPeerId, signedInvoice);
              console.log(`[${name}] Sent invoice for milestone: ${milestone.amount} ${agreement.token}`);
            }
          } else {
            console.log(`[${name}] Milestone ${approval.milestoneId} rejected`);
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
    escrowAgreements,
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
  const escrowAgreements = new Map<string, EscrowAgreement>();

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
          console.log(`[${name}] Received invoice: ${invoice.amount} ${invoice.token} to ${invoice.recipient.slice(0, 10)}...`);

          const ledgerEntry: PaymentLedgerEntry = {
            id: crypto.randomUUID(),
            type: 'escrow',
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
            type: 'escrow',
            ledgerEntryId: ledgerEntry.id,
            invoice,
            priority: 1,
            createdAt: Date.now(),
            retryCount: 0,
            maxRetries: 3,
          };
          pendingSettlements.push(settlement);
          await writeSettlement(settlement);

          console.log(`[${name}] Queued settlement for ${invoice.amount} ${invoice.token}`);
        }
      },
    }
  );

  console.log(`[${name}] Started with ID: ${node.id}`);

  return {
    node,
    auth,
    wallet,
    escrowAgreements,
    receivedInvoices,
    pendingSettlements,
    paymentLedger,
  };
}

async function createApproverAgent(
  name: string,
  walletRpcUrls?: Record<number, string>
): Promise<AgentState> {
  console.log(`\n[${name}] Initializing approver agent...`);

  await storageInitialize(name);

  const keys = await loadOrCreateKeys(APPROVER_KEY_PATH);
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

  let nodeRef: EccoNode | null = null;

  const node = await ecco(
    {
      discovery: ['mdns', 'gossip'],
      nodeId: name,
      capabilities: [
        {
          type: 'agent',
          name: 'code-approver',
          version: '1.0.0',
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

        if (message.type === 'escrow-approval') {
          const approval = message.payload as {
            agreementId: string;
            milestoneId: string;
            approved: boolean;
            servicePeerId: string;
          };

          console.log(`[${name}] Received approval request for milestone ${approval.milestoneId}`);
          console.log(`[${name}] Forwarding approval to service agent...`);

          if (nodeRef) {
            const forwardMessage: Message = {
              id: crypto.randomUUID(),
              from: nodeRef.id,
              to: approval.servicePeerId,
              type: 'escrow-approval',
              payload: {
                agreementId: approval.agreementId,
                milestoneId: approval.milestoneId,
                approved: approval.approved,
                timestamp: Date.now(),
              },
              timestamp: Date.now(),
            };

            const signedForward = await signMessage(auth, forwardMessage);
            await sendMessage(nodeRef.ref, approval.servicePeerId, signedForward);
            console.log(`[${name}] Approval forwarded to ${approval.servicePeerId}`);
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
    escrowAgreements: new Map(),
    receivedInvoices: [],
    pendingSettlements: [],
    paymentLedger: [],
  };
}

interface EscrowJobResult {
  agreementId: string;
  totalAmount: string;
  milestonesReleased: number;
  transactions: Array<{ amount: string; txHash: string }>;
}

async function startEscrowJob(
  client: AgentState,
  servicePeerId: string,
  approverPeerId: string
): Promise<EscrowJobResult> {
  const clientId = client.node.id;

  console.log(`\n[${clientId}] Starting escrow job`);
  console.log(`[${clientId}] Service: ${servicePeerId}`);
  console.log(`[${clientId}] Approver: ${approverPeerId}`);

  const jobId = `escrow-job-${Date.now()}`;
  const totalAmount = '0.001';
  const milestoneAmounts = ['0.0005', '0.0005'];

  const agreement = createEscrowAgreement(
    jobId,
    clientId,
    servicePeerId,
    ETH_SEPOLIA_CHAIN_ID,
    'ETH',
    totalAmount,
    milestoneAmounts,
    true,
    approverPeerId
  );

  client.escrowAgreements.set(agreement.id, agreement);
  await writeEscrowAgreement(agreement);

  console.log(`[${clientId}] Created escrow agreement: ${agreement.id}`);
  console.log(`[${clientId}] Total amount: ${totalAmount} ETH`);
  console.log(`[${clientId}] Milestones: ${agreement.milestones.length}`);
  console.log(`[${clientId}] Requires approval: ${agreement.requiresApproval}`);

  const clientPeerId = getLibp2pPeerId(client.node.ref);

  const agreementMessage: Message = {
    id: crypto.randomUUID(),
    from: clientId,
    to: servicePeerId,
    type: 'agent-request',
    payload: { escrowAgreement: agreement, clientPeerId },
    timestamp: Date.now(),
  };

  const signedAgreement = await signMessage(client.auth, agreementMessage);
  await sendMessage(client.node.ref, servicePeerId, signedAgreement);
  console.log(`[${clientId}] Sent escrow agreement to service agent`);

  console.log(`\n[${clientId}] Simulating work completion...`);
  await delay(2000);

  for (let i = 0; i < agreement.milestones.length; i++) {
    const milestone = agreement.milestones[i];
    console.log(`\n[${clientId}] Requesting approval for milestone ${i + 1}...`);

    const approvalRequest: Message = {
      id: crypto.randomUUID(),
      from: clientId,
      to: approverPeerId,
      type: 'escrow-approval',
      payload: {
        agreementId: agreement.id,
        milestoneId: milestone.id,
        approved: true,
        servicePeerId,
      },
      timestamp: Date.now(),
    };

    const signedApproval = await signMessage(client.auth, approvalRequest);
    await sendMessage(client.node.ref, approverPeerId, signedApproval);
    console.log(`[${clientId}] Approval request sent for milestone ${i + 1}`);

    await delay(2000);
  }

  await delay(3000);

  const transactions: Array<{ amount: string; txHash: string }> = [];

  if (client.wallet && client.pendingSettlements.length > 0) {
    console.log(`\n[${clientId}] Processing settlements...`);
    console.log(`[${clientId}] Pending settlements: ${client.pendingSettlements.length}`);

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
    agreementId: agreement.id,
    totalAmount,
    milestonesReleased: agreement.milestones.length,
    transactions,
  };
}

async function main(): Promise<void> {
  console.log('=== Escrow Payments Example ===\n');
  console.log('This example demonstrates:');
  console.log('1. Client creates escrow agreement with milestones (50/50 split)');
  console.log('2. Service agent receives the agreement');
  console.log('3. Approver agent validates and approves each milestone');
  console.log('4. Payments are released per milestone');
  console.log('5. Batch settlements (aggregate invoices into single transaction)\n');

  const ethRpcUrl = process.env.RPC_URL;
  const walletRpcUrls: Record<number, string> = {};

  if (ethRpcUrl) {
    walletRpcUrls[ETH_SEPOLIA_CHAIN_ID] = ethRpcUrl;
    console.log(`Using RPC: ${ethRpcUrl.replace(/\/v2\/[^/]+$/, '/v2/***')}\n`);
  } else {
    console.log('No RPC_URL provided - running in simulation mode\n');
    console.log('To enable real transactions, run with:');
    console.log('  RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY bun run examples/escrow-payments.ts\n');
  }

  const serviceAgent = await createServiceAgent('escrow-service', walletRpcUrls);
  const clientAgent = await createClientAgent('escrow-client', walletRpcUrls);
  const approverAgent = await createApproverAgent('escrow-approver', walletRpcUrls);

  console.log('\nWaiting for peer discovery...\n');
  await delay(3000);

  await broadcastCapabilities(serviceAgent.node.ref);
  await broadcastCapabilities(clientAgent.node.ref);
  await broadcastCapabilities(approverAgent.node.ref);
  await delay(2000);

  const servicePeers = await findPeers(clientAgent.node.ref, {
    requiredCapabilities: [
      {
        type: 'agent',
        name: 'code-review-service',
      },
    ],
  });

  const approverPeers = await findPeers(clientAgent.node.ref, {
    requiredCapabilities: [
      {
        type: 'agent',
        name: 'code-approver',
      },
    ],
  });

  if (servicePeers.length === 0) {
    console.error('Service agent not found!');
    await stop(serviceAgent.node.ref);
    await stop(clientAgent.node.ref);
    await stop(approverAgent.node.ref);
    process.exit(1);
  }

  if (approverPeers.length === 0) {
    console.error('Approver agent not found!');
    await stop(serviceAgent.node.ref);
    await stop(clientAgent.node.ref);
    await stop(approverAgent.node.ref);
    process.exit(1);
  }

  const servicePeer = servicePeers[0].peer;
  const approverPeer = approverPeers[0].peer;

  console.log(`Found service peer: ${servicePeer.id}`);
  console.log(`Found approver peer: ${approverPeer.id}`);

  const jobResult = await startEscrowJob(clientAgent, servicePeer.id, approverPeer.id);

  console.log('\n=== Summary ===');
  console.log(`Agreement ID: ${jobResult.agreementId}`);
  console.log(`Total amount: ${jobResult.totalAmount} ETH`);
  console.log(`Milestones released: ${jobResult.milestonesReleased}`);
  console.log(`Service escrow agreements: ${serviceAgent.escrowAgreements.size}`);
  console.log(`Client invoices received: ${clientAgent.receivedInvoices.length}`);

  console.log('\n=== Wallet Addresses ===');
  const serviceAddress = serviceAgent.wallet ? getAddress(serviceAgent.wallet) : 'N/A (simulation mode)';
  const clientAddress = clientAgent.wallet ? getAddress(clientAgent.wallet) : 'N/A (simulation mode)';
  const approverAddress = approverAgent.wallet ? getAddress(approverAgent.wallet) : 'N/A (simulation mode)';
  console.log(`Service wallet:  ${serviceAddress}`);
  console.log(`Client wallet:   ${clientAddress}`);
  console.log(`Approver wallet: ${approverAddress}`);

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
  console.log('[escrow-service] Stopped');
  await stop(clientAgent.node.ref);
  console.log('[escrow-client] Stopped');
  await stop(approverAgent.node.ref);
  console.log('[escrow-approver] Stopped');

  console.log('\nExample complete!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
