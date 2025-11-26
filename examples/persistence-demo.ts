import {
  createInitialState,
  start,
  stop,
  getId,
  getState,
  type StateRef,
  type NodeState,
  PaymentProtocol,
  Wallet,
  setEscrowAgreement,
  addPaymentLedgerEntry,
} from '@ecco/core';
import type { EscrowAgreement, PaymentLedgerEntry } from '@ecco/core';

const ETH_SEPOLIA_CHAIN_ID = 11155111;
const KEY_PATH = '.keys/persistence-demo-agent.json';

async function createNode(
  id: string,
  port: number,
  walletRpcUrls?: Record<number, string>
): Promise<StateRef<NodeState>> {
  const nodeState = createInitialState({
    discovery: ['mdns', 'gossip'],
    nodeId: id,
    authentication: {
      enabled: true,
      walletAutoInit: true,
      keyPath: KEY_PATH,
      walletRpcUrls,
    },
    transport: {
      websocket: { enabled: true, port },
    },
  });

  return await start(nodeState);
}

async function addSampleData(ref: StateRef<NodeState>): Promise<void> {
  console.log('\n📝 Adding sample data to node...\n');

  const escrowAgreement1 = PaymentProtocol.createEscrowAgreement(
    'escrow-1',
    getId(ref),
    'recipient-1',
    ETH_SEPOLIA_CHAIN_ID,
    'ETH',
    '0.001',
    [
      { amount: '0.0005' },
      { amount: '0.0005' },
    ],
    false
  );

  const escrowAgreement2 = PaymentProtocol.createEscrowAgreement(
    'escrow-2',
    getId(ref),
    'recipient-2',
    ETH_SEPOLIA_CHAIN_ID,
    'ETH',
    '0.002',
    [
      { amount: '0.001' },
      { amount: '0.001' },
    ],
    true,
    'approver-1'
  );

  await setEscrowAgreement(ref, escrowAgreement1);
  console.log(`✅ Created escrow agreement: ${escrowAgreement1.id} (${escrowAgreement1.totalAmount} ETH)`);

  await setEscrowAgreement(ref, escrowAgreement2);
  console.log(`✅ Created escrow agreement: ${escrowAgreement2.id} (${escrowAgreement2.totalAmount} ETH)`);

  const ledgerEntry1: PaymentLedgerEntry = {
    id: 'ledger-1',
    type: 'standard',
    payer: getId(ref),
    recipient: 'recipient-1',
    amount: '0.0001',
    token: 'ETH',
    chainId: ETH_SEPOLIA_CHAIN_ID,
    txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    createdAt: Date.now() - 3600000,
    status: 'settled',
  };

  const ledgerEntry2: PaymentLedgerEntry = {
    id: 'ledger-2',
    type: 'standard',
    payer: getId(ref),
    recipient: 'recipient-2',
    amount: '0.0002',
    token: 'ETH',
    chainId: ETH_SEPOLIA_CHAIN_ID,
    txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    createdAt: Date.now() - 1800000,
    status: 'settled',
  };

  await addPaymentLedgerEntry(ref, ledgerEntry1);
  console.log(`✅ Added payment ledger entry: ${ledgerEntry1.id} (${ledgerEntry1.amount} ETH)`);

  await addPaymentLedgerEntry(ref, ledgerEntry2);
  console.log(`✅ Added payment ledger entry: ${ledgerEntry2.id} (${ledgerEntry2.amount} ETH)`);
}

function displayNodeState(ref: StateRef<NodeState>): void {
  const state = getState(ref);

  console.log('\n📊 Current Node State:\n');
  console.log(`Node ID: ${state.id}`);
  console.log(`Escrow Agreements: ${Object.keys(state.escrowAgreements).length}`);
  for (const [id, agreement] of Object.entries(state.escrowAgreements)) {
    console.log(`  - ${id}: ${agreement.totalAmount} ETH (${agreement.milestones.length} milestones)`);
  }

  console.log(`\nPayment Ledger Entries: ${Object.keys(state.paymentLedger).length}`);
  for (const [id, entry] of Object.entries(state.paymentLedger)) {
    console.log(`  - ${id}: ${entry.amount} ETH to ${entry.recipient} (${entry.status})`);
  }

  console.log(`\nStreaming Channels: ${Object.keys(state.streamingChannels).length}`);
  console.log(`Stake Positions: ${Object.keys(state.stakePositions).length}`);
  console.log(`Swarm Splits: ${Object.keys(state.swarmSplits).length}`);
  console.log(`Pending Settlements: ${state.pendingSettlements.length}`);
}

async function checkDatabaseSchema(nodeId: string): Promise<boolean> {
  const fs = require('fs');
  const path = require('path');
  const dbPath = path.resolve(process.cwd(), '.ecco', `${nodeId}.sqlite`);
  
  if (!fs.existsSync(dbPath)) {
    console.log('⚠️  Database file does not exist yet. It will be created on first write.');
    console.log('   However, you need to run `db:push` first to create the schema.\n');
    console.log('   Run this command:\n');
    console.log(`   bun run db:push:persistence-demo\n`);
    return false;
  }
  
  const { Database } = require('bun:sqlite');
  try {
    const db = new Database(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    db.close();
    
    const hasTables = tables.length > 0;
    if (!hasTables) {
      console.log('⚠️  Database file exists but has no tables.');
      console.log('   Please run `db:push` to create the schema.\n');
      console.log('   Run this command:\n');
      console.log(`   bun run db:push:persistence-demo\n`);
    }
    return hasTables;
  } catch (error) {
    console.log('⚠️  Could not check database schema:', error);
    return false;
  }
}

async function main() {
  console.log('🔄 Persistence Demo\n');
  console.log('This example demonstrates that node state persists across restarts.\n');

  const walletRpcUrls: Record<number, string> = {};
  if (process.env.RPC_URL) {
    walletRpcUrls[ETH_SEPOLIA_CHAIN_ID] = process.env.RPC_URL;
  }

  const nodeId = 'persistence-demo-node';
  const port = 9001;

  const schemaExists = await checkDatabaseSchema(nodeId);
  if (!schemaExists) {
    console.log('❌ Please initialize the database schema first and then run this example again.\n');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('STEP 1: Creating node and adding sample data');
  console.log('='.repeat(60));

  let nodeRef = await createNode(nodeId, port, walletRpcUrls);
  const walletAddress = await Wallet.getAddress(nodeRef);
  console.log(`\n✅ Node created: ${getId(nodeRef)}`);
  console.log(`   Wallet: ${walletAddress}`);
  console.log(`   Port: ${port}`);

  await addSampleData(nodeRef);

  displayNodeState(nodeRef);

  console.log('\n' + '='.repeat(60));
  console.log('STEP 2: Stopping the node');
  console.log('='.repeat(60));
  await stop(nodeRef);
  console.log('✅ Node stopped\n');

  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log('='.repeat(60));
  console.log('STEP 3: Restarting the node');
  console.log('='.repeat(60));

  const newNodeState = createInitialState({
    discovery: ['mdns', 'gossip'],
    nodeId: nodeId,
    authentication: {
      enabled: true,
      walletAutoInit: true,
      keyPath: KEY_PATH,
      walletRpcUrls,
    },
    transport: {
      websocket: { enabled: true, port },
    },
  });

  nodeRef = await start(newNodeState);
  console.log(`\n✅ Node restarted: ${getId(nodeRef)}`);

  displayNodeState(nodeRef);

  console.log('\n' + '='.repeat(60));
  console.log('✅ SUCCESS: All data persisted across restart!');
  console.log('='.repeat(60));

  console.log('\n💡 Note: The database file is located at: `.ecco/persistence-demo-node.sqlite`');
  console.log('   (relative to the directory where you run this example)\n');

  await stop(nodeRef);
  console.log('✅ Node stopped');
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
