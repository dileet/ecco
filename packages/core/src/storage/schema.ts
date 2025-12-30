import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import type {
  EscrowAgreement,
  EscrowMilestone,
  PaymentLedgerEntry,
  StreamingAgreement,
  StakePosition,
  SwarmSplit,
  SwarmParticipant,
  SettlementIntent,
  Invoice,
} from '../types';

export const escrowAgreements = sqliteTable('escrow_agreements', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  payer: text('payer').notNull(),
  recipient: text('recipient').notNull(),
  chainId: integer('chain_id').notNull(),
  token: text('token').notNull(),
  totalAmount: text('total_amount').notNull(),
  milestones: text('milestones').notNull(),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
  requiresApproval: integer('requires_approval', { mode: 'boolean' }).notNull(),
  approver: text('approver'),
});

export const paymentLedger = sqliteTable('payment_ledger', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  status: text('status').notNull(),
  chainId: integer('chain_id').notNull(),
  token: text('token').notNull(),
  amount: text('amount').notNull(),
  recipient: text('recipient').notNull(),
  payer: text('payer').notNull(),
  jobId: text('job_id'),
  createdAt: integer('created_at').notNull(),
  settledAt: integer('settled_at'),
  txHash: text('tx_hash'),
  metadata: text('metadata'),
});

export const streamingChannels = sqliteTable('streaming_channels', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  payer: text('payer').notNull(),
  recipient: text('recipient').notNull(),
  chainId: integer('chain_id').notNull(),
  token: text('token').notNull(),
  ratePerToken: text('rate_per_token').notNull(),
  accumulatedAmount: text('accumulated_amount').notNull(),
  lastTick: integer('last_tick').notNull(),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
  closedAt: integer('closed_at'),
});

export const stakePositions = sqliteTable('stake_positions', {
  id: text('id').primaryKey(),
  stakeRequirementId: text('stake_requirement_id').notNull(),
  jobId: text('job_id').notNull(),
  staker: text('staker').notNull(),
  chainId: integer('chain_id').notNull(),
  token: text('token').notNull(),
  amount: text('amount').notNull(),
  status: text('status').notNull(),
  lockedAt: integer('locked_at').notNull(),
  releasedAt: integer('released_at'),
  slashedAt: integer('slashed_at'),
  txHash: text('tx_hash'),
  releaseTxHash: text('release_tx_hash'),
  slashTxHash: text('slash_tx_hash'),
});

export const swarmSplits = sqliteTable('swarm_splits', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  payer: text('payer').notNull(),
  totalAmount: text('total_amount').notNull(),
  chainId: integer('chain_id').notNull(),
  token: text('token').notNull(),
  participants: text('participants').notNull(),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
  distributedAt: integer('distributed_at'),
});

export const pendingSettlements = sqliteTable('pending_settlements', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  ledgerEntryId: text('ledger_entry_id').notNull(),
  invoice: text('invoice'),
  priority: integer('priority').notNull(),
  createdAt: integer('created_at').notNull(),
  retryCount: integer('retry_count').notNull(),
  maxRetries: integer('max_retries').notNull(),
});

export const processedPaymentProofs = sqliteTable('processed_payment_proofs', {
  txHash: text('tx_hash').primaryKey(),
  chainId: integer('chain_id').notNull(),
  invoiceId: text('invoice_id').notNull(),
  processedAt: integer('processed_at').notNull(),
});

export const timedOutPayments = sqliteTable('timed_out_payments', {
  invoiceId: text('invoice_id').primaryKey(),
  jobId: text('job_id').notNull(),
  chainId: integer('chain_id').notNull(),
  amount: text('amount').notNull(),
  token: text('token').notNull(),
  recipient: text('recipient').notNull(),
  validUntil: integer('valid_until').notNull(),
  tokenAddress: text('token_address'),
  timedOutAt: integer('timed_out_at').notNull(),
  status: text('status').notNull(),
  recoveredAt: integer('recovered_at'),
  txHash: text('tx_hash'),
});

export const expectedInvoices = sqliteTable('expected_invoices', {
  jobId: text('job_id').primaryKey(),
  expectedRecipient: text('expected_recipient').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

