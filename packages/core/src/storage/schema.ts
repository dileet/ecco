import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

export const EscrowMilestoneSchema = z.object({
  id: z.string(),
  amount: z.string(),
  released: z.boolean(),
  status: z.enum(['pending', 'approved', 'released', 'cancelled']).nullable(),
  releasedAt: z.number().nullable(),
});

export const SwarmParticipantSchema = z.object({
  peerId: z.string(),
  walletAddress: z.string(),
  contribution: z.number(),
  amount: z.string(),
});

export const StoredInvoiceSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  chainId: z.number(),
  amount: z.string(),
  token: z.string(),
  tokenAddress: z.string().nullable(),
  recipient: z.string(),
  validUntil: z.number(),
  signature: z.string().nullable(),
  publicKey: z.string().nullable(),
});

export type EscrowMilestone = z.infer<typeof EscrowMilestoneSchema>;
export type SwarmParticipant = z.infer<typeof SwarmParticipantSchema>;
export type StoredInvoice = z.infer<typeof StoredInvoiceSchema>;

export const escrowAgreements = sqliteTable('escrow_agreements', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  payer: text('payer').notNull(),
  recipient: text('recipient').notNull(),
  chainId: integer('chain_id').notNull(),
  token: text('token').notNull(),
  totalAmount: text('total_amount').notNull(),
  milestones: text('milestones', { mode: 'json' }).notNull().$type<EscrowMilestone[]>(),
  status: text('status').notNull().$type<'pending' | 'locked' | 'partially-released' | 'fully-released' | 'cancelled'>(),
  createdAt: integer('created_at').notNull(),
  requiresApproval: integer('requires_approval', { mode: 'boolean' }).notNull(),
  approver: text('approver'),
});

export const paymentLedger = sqliteTable('payment_ledger', {
  id: text('id').primaryKey(),
  type: text('type').notNull().$type<'streaming' | 'escrow' | 'stake' | 'swarm' | 'standard'>(),
  status: text('status').notNull().$type<'pending' | 'streaming' | 'settled' | 'failed' | 'cancelled'>(),
  chainId: integer('chain_id').notNull(),
  token: text('token').notNull(),
  amount: text('amount').notNull(),
  recipient: text('recipient').notNull(),
  payer: text('payer').notNull(),
  jobId: text('job_id'),
  createdAt: integer('created_at').notNull(),
  settledAt: integer('settled_at'),
  txHash: text('tx_hash'),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown> | null>(),
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
  status: text('status').notNull().$type<'active' | 'closed'>(),
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
  status: text('status').notNull().$type<'locked' | 'released' | 'slashed'>(),
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
  participants: text('participants', { mode: 'json' }).notNull().$type<SwarmParticipant[]>(),
  status: text('status').notNull().$type<'pending' | 'distributed' | 'failed'>(),
  createdAt: integer('created_at').notNull(),
  distributedAt: integer('distributed_at'),
});

export const pendingSettlements = sqliteTable('pending_settlements', {
  id: text('id').primaryKey(),
  type: text('type').notNull().$type<'streaming' | 'escrow' | 'stake-release' | 'stake-slash' | 'swarm' | 'standard'>(),
  ledgerEntryId: text('ledger_entry_id').notNull(),
  invoice: text('invoice', { mode: 'json' }).$type<StoredInvoice | null>(),
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
  status: text('status').notNull().$type<'pending' | 'recovered' | 'expired'>(),
  recoveredAt: integer('recovered_at'),
  txHash: text('tx_hash'),
});

export const expectedInvoices = sqliteTable('expected_invoices', {
  jobId: text('job_id').primaryKey(),
  expectedRecipient: text('expected_recipient').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export type EscrowAgreement = typeof escrowAgreements.$inferSelect;
export type PaymentLedgerEntry = typeof paymentLedger.$inferSelect;
export type StreamingAgreement = typeof streamingChannels.$inferSelect;
export type StakePosition = typeof stakePositions.$inferSelect;
export type SwarmSplit = typeof swarmSplits.$inferSelect;
export type SettlementIntent = typeof pendingSettlements.$inferSelect;
export type TimedOutPayment = typeof timedOutPayments.$inferSelect;
export type ExpectedInvoice = typeof expectedInvoices.$inferSelect;
export type ProcessedPaymentProof = typeof processedPaymentProofs.$inferSelect;

export const escrowAgreementSchema = createSelectSchema(escrowAgreements);
export const paymentLedgerSchema = createSelectSchema(paymentLedger);
export const streamingChannelSchema = createSelectSchema(streamingChannels);
export const stakePositionSchema = createSelectSchema(stakePositions);
export const swarmSplitSchema = createSelectSchema(swarmSplits);
export const settlementIntentSchema = createSelectSchema(pendingSettlements);
