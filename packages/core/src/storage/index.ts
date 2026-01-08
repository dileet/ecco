import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { and, eq } from 'drizzle-orm';
import {
  escrowAgreements,
  paymentLedger,
  streamingChannels,
  stakePositions,
  swarmSplits,
  pendingSettlements,
  processedPaymentProofs,
  timedOutPayments,
  expectedInvoices,
} from './schema';
import type {
  EscrowAgreement,
  PaymentLedgerEntry,
  StreamingAgreement,
  StakePosition,
  SwarmSplit,
  SettlementIntent,
  Invoice,
} from '../types';
import { toHexAddress } from '../utils';

export interface TimedOutPaymentRecord {
  invoice: Invoice;
  timedOutAt: number;
  status: 'pending' | 'recovered' | 'expired';
  recoveredAt?: number;
  txHash?: string;
}

let dbInstance: ReturnType<typeof drizzle> | null = null;
let sqliteDb: Database | null = null;
let currentNodeId: string | null = null;
let dbNodeId: string | null = null;
let initPromise: Promise<void> | null = null;

const getSqliteDb = (): Database | null => sqliteDb;

export const runTransaction = <T>(operation: () => T): T => {
  const db = getSqliteDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.run('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.run('COMMIT');
    return result;
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
};

const getEccoDir = (): string => path.resolve(homedir(), '.ecco');
const getDbPath = (nodeId: string): string => path.join(getEccoDir(), `${nodeId}.sqlite`);

const getDb = (): ReturnType<typeof drizzle> | null => dbInstance;
const isDbReady = (nodeId: string): boolean => dbInstance !== null && dbNodeId === nodeId;

const openDatabase = (nodeId: string, createIfMissing: boolean): void => {
  const dbPath = getDbPath(nodeId);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!createIfMissing && !fs.existsSync(dbPath)) {
    return;
  }
  sqliteDb = new Database(dbPath);
  dbInstance = drizzle({ client: sqliteDb });
  dbNodeId = nodeId;
};

const initializeDatabase = async (
  nodeId: string,
  createIfMissing: boolean
): Promise<void> => {
  if (isDbReady(nodeId)) {
    return;
  }
  if (initPromise) {
    const pendingInit = initPromise;
    await pendingInit;
    if (isDbReady(nodeId)) {
      return;
    }
  }
  initPromise = Promise.resolve().then(() => {
    if (isDbReady(nodeId)) {
      return;
    }
    openDatabase(nodeId, createIfMissing);
  });
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
};

const ensureDbInitialized = async (): Promise<void> => {
  if (!currentNodeId) {
    throw new Error('Node ID not set');
  }
  await initializeDatabase(currentNodeId, true);
};

const isNoSuchTableError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('no such table');

export const initialize = async (nodeId: string): Promise<void> => {
  currentNodeId = nodeId;
  await initializeDatabase(nodeId, false);
};

export const close = (): void => {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
  dbInstance = null;
  currentNodeId = null;
  dbNodeId = null;
  initPromise = null;
};

export const loadEscrowAgreements = async (): Promise<Record<string, EscrowAgreement>> => {
  const db = getDb();
  if (!db) {
    return {};
  }
  try {
    const rows = db.select().from(escrowAgreements).all();
    const result: Record<string, EscrowAgreement> = {};
    for (const row of rows) {
      result[row.id] = {
        id: row.id,
        jobId: row.jobId,
        payer: row.payer,
        recipient: row.recipient,
        chainId: row.chainId,
        token: row.token,
        totalAmount: row.totalAmount,
        milestones: JSON.parse(row.milestones),
        status: row.status as EscrowAgreement['status'],
        createdAt: row.createdAt,
        requiresApproval: row.requiresApproval,
        approver: row.approver || undefined,
      };
    }
    return result;
  } catch (error) {
    if (isNoSuchTableError(error)) {
      return {};
    }
    throw new Error('Failed to load escrow agreements');
  }
};

export const loadPaymentLedger = async (): Promise<Record<string, PaymentLedgerEntry>> => {
  const db = getDb();
  if (!db) {
    return {};
  }
  try {
    const rows = db.select().from(paymentLedger).all();
    const result: Record<string, PaymentLedgerEntry> = {};
    for (const row of rows) {
      result[row.id] = {
        id: row.id,
        type: row.type as PaymentLedgerEntry['type'],
        status: row.status as PaymentLedgerEntry['status'],
        chainId: row.chainId,
        token: row.token,
        amount: row.amount,
        recipient: row.recipient,
        payer: row.payer,
        jobId: row.jobId || undefined,
        createdAt: row.createdAt,
        settledAt: row.settledAt || undefined,
        txHash: row.txHash || undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      };
    }
    return result;
  } catch (error) {
    if (isNoSuchTableError(error)) {
      return {};
    }
    throw new Error('Failed to load payment ledger');
  }
};

export const loadStreamingChannels = async (): Promise<Record<string, StreamingAgreement>> => {
  const db = getDb();
  if (!db) {
    return {};
  }
  try {
    const rows = db.select().from(streamingChannels).all();
    const result: Record<string, StreamingAgreement> = {};
    for (const row of rows) {
      result[row.id] = {
        id: row.id,
        jobId: row.jobId,
        payer: row.payer,
        recipient: row.recipient,
        chainId: row.chainId,
        token: row.token,
        ratePerToken: row.ratePerToken,
        accumulatedAmount: row.accumulatedAmount,
        lastTick: row.lastTick,
        status: row.status as StreamingAgreement['status'],
        createdAt: row.createdAt,
        closedAt: row.closedAt || undefined,
      };
    }
    return result;
  } catch (error) {
    if (isNoSuchTableError(error)) {
      return {};
    }
    throw new Error('Failed to load streaming channels');
  }
};

export const loadStakePositions = async (): Promise<Record<string, StakePosition>> => {
  const db = getDb();
  if (!db) {
    return {};
  }
  try {
    const rows = db.select().from(stakePositions).all();
    const result: Record<string, StakePosition> = {};
    for (const row of rows) {
      result[row.id] = {
        id: row.id,
        stakeRequirementId: row.stakeRequirementId,
        jobId: row.jobId,
        staker: row.staker,
        chainId: row.chainId,
        token: row.token,
        amount: row.amount,
        status: row.status as StakePosition['status'],
        lockedAt: row.lockedAt,
        releasedAt: row.releasedAt || undefined,
        slashedAt: row.slashedAt || undefined,
        txHash: row.txHash || undefined,
        releaseTxHash: row.releaseTxHash || undefined,
        slashTxHash: row.slashTxHash || undefined,
      };
    }
    return result;
  } catch (error) {
    if (isNoSuchTableError(error)) {
      return {};
    }
    throw new Error('Failed to load stake positions');
  }
};

export const loadSwarmSplits = async (): Promise<Record<string, SwarmSplit>> => {
  const db = getDb();
  if (!db) {
    return {};
  }
  try {
    const rows = db.select().from(swarmSplits).all();
    const result: Record<string, SwarmSplit> = {};
    for (const row of rows) {
      result[row.id] = {
        id: row.id,
        jobId: row.jobId,
        payer: row.payer,
        totalAmount: row.totalAmount,
        chainId: row.chainId,
        token: row.token,
        participants: JSON.parse(row.participants),
        status: row.status as SwarmSplit['status'],
        createdAt: row.createdAt,
        distributedAt: row.distributedAt || undefined,
      };
    }
    return result;
  } catch (error) {
    if (isNoSuchTableError(error)) {
      return {};
    }
    throw new Error('Failed to load swarm splits');
  }
};

export const loadPendingSettlements = async (): Promise<SettlementIntent[]> => {
  const db = getDb();
  if (!db) {
    return [];
  }
  try {
    const rows = db.select().from(pendingSettlements).all();
    const settlements: SettlementIntent[] = [];
    for (const row of rows) {
      settlements.push({
        id: row.id,
        type: row.type as SettlementIntent['type'],
        ledgerEntryId: row.ledgerEntryId,
        invoice: row.invoice ? JSON.parse(row.invoice) : undefined,
        priority: row.priority,
        createdAt: row.createdAt,
        retryCount: row.retryCount,
        maxRetries: row.maxRetries,
      });
    }
    return settlements;
  } catch (error) {
    if (isNoSuchTableError(error)) {
      return [];
    }
    throw new Error('Failed to load pending settlements');
  }
};

export const writeEscrowAgreement = async (agreement: EscrowAgreement): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  await db.insert(escrowAgreements)
    .values({
      id: agreement.id,
      jobId: agreement.jobId,
      payer: agreement.payer,
      recipient: agreement.recipient,
      chainId: agreement.chainId,
      token: agreement.token,
      totalAmount: agreement.totalAmount,
      milestones: JSON.stringify(agreement.milestones),
      status: agreement.status,
      createdAt: agreement.createdAt,
      requiresApproval: agreement.requiresApproval,
      approver: agreement.approver || null,
    })
    .onConflictDoUpdate({
      target: escrowAgreements.id,
      set: {
        jobId: agreement.jobId,
        payer: agreement.payer,
        recipient: agreement.recipient,
        chainId: agreement.chainId,
        token: agreement.token,
        totalAmount: agreement.totalAmount,
        milestones: JSON.stringify(agreement.milestones),
        status: agreement.status,
        requiresApproval: agreement.requiresApproval,
        approver: agreement.approver ?? null,
      },
    });
};

export const updateEscrowAgreement = async (agreement: EscrowAgreement): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  await db.update(escrowAgreements)
    .set({
      jobId: agreement.jobId,
      payer: agreement.payer,
      recipient: agreement.recipient,
      chainId: agreement.chainId,
      token: agreement.token,
      totalAmount: agreement.totalAmount,
      milestones: JSON.stringify(agreement.milestones),
      status: agreement.status,
      requiresApproval: agreement.requiresApproval,
      approver: agreement.approver ?? null,
    })
    .where(eq(escrowAgreements.id, agreement.id));
};

export const updateEscrowAgreementIfUnchanged = async (
  agreement: EscrowAgreement,
  expectedMilestones: EscrowAgreement['milestones']
): Promise<boolean> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  const expectedMilestonesJson = JSON.stringify(expectedMilestones);
  const result = db.update(escrowAgreements)
    .set({
      jobId: agreement.jobId,
      payer: agreement.payer,
      recipient: agreement.recipient,
      chainId: agreement.chainId,
      token: agreement.token,
      totalAmount: agreement.totalAmount,
      milestones: JSON.stringify(agreement.milestones),
      status: agreement.status,
      requiresApproval: agreement.requiresApproval,
      approver: agreement.approver ?? null,
    })
    .where(and(
      eq(escrowAgreements.id, agreement.id),
      eq(escrowAgreements.milestones, expectedMilestonesJson)
    ))
    .run();

  return result.changes > 0;
};

export const writePaymentLedgerEntry = async (entry: PaymentLedgerEntry): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.insert(paymentLedger)
    .values({
      id: entry.id,
      type: entry.type,
      status: entry.status,
      chainId: entry.chainId,
      token: entry.token,
      amount: entry.amount,
      recipient: entry.recipient,
      payer: entry.payer,
      jobId: entry.jobId || null,
      createdAt: entry.createdAt,
      settledAt: entry.settledAt || null,
      txHash: entry.txHash || null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    })
    .onConflictDoUpdate({
      target: paymentLedger.id,
      set: {
        type: entry.type,
        status: entry.status,
        chainId: entry.chainId,
        token: entry.token,
        amount: entry.amount,
        recipient: entry.recipient,
        payer: entry.payer,
        jobId: entry.jobId || null,
        settledAt: entry.settledAt || null,
        txHash: entry.txHash || null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      },
    })
    .run();
};

export const updatePaymentLedgerEntry = async (entry: PaymentLedgerEntry): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.update(paymentLedger)
    .set({
      type: entry.type,
      status: entry.status,
      chainId: entry.chainId,
      token: entry.token,
      amount: entry.amount,
      recipient: entry.recipient,
      payer: entry.payer,
      jobId: entry.jobId || null,
      settledAt: entry.settledAt || null,
      txHash: entry.txHash || null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    })
    .where(eq(paymentLedger.id, entry.id))
    .run();
};

export const writeStreamingChannel = async (channel: StreamingAgreement): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.insert(streamingChannels)
    .values({
      id: channel.id,
      jobId: channel.jobId,
      payer: channel.payer,
      recipient: channel.recipient,
      chainId: channel.chainId,
      token: channel.token,
      ratePerToken: channel.ratePerToken,
      accumulatedAmount: channel.accumulatedAmount,
      lastTick: channel.lastTick,
      status: channel.status,
      createdAt: channel.createdAt,
      closedAt: channel.closedAt || null,
    })
    .onConflictDoUpdate({
      target: streamingChannels.id,
      set: {
        jobId: channel.jobId,
        payer: channel.payer,
        recipient: channel.recipient,
        chainId: channel.chainId,
        token: channel.token,
        ratePerToken: channel.ratePerToken,
        accumulatedAmount: channel.accumulatedAmount,
        lastTick: channel.lastTick,
        status: channel.status,
        closedAt: channel.closedAt || null,
      },
    })
    .run();
};

export const updateStreamingChannel = async (channel: StreamingAgreement): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.update(streamingChannels)
    .set({
      jobId: channel.jobId,
      payer: channel.payer,
      recipient: channel.recipient,
      chainId: channel.chainId,
      token: channel.token,
      ratePerToken: channel.ratePerToken,
      accumulatedAmount: channel.accumulatedAmount,
      lastTick: channel.lastTick,
      status: channel.status,
      closedAt: channel.closedAt || null,
    })
    .where(eq(streamingChannels.id, channel.id))
    .run();
};

export const writeStakePosition = async (position: StakePosition): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.insert(stakePositions)
    .values({
      id: position.id,
      stakeRequirementId: position.stakeRequirementId,
      jobId: position.jobId,
      staker: position.staker,
      chainId: position.chainId,
      token: position.token,
      amount: position.amount,
      status: position.status,
      lockedAt: position.lockedAt,
      releasedAt: position.releasedAt || null,
      slashedAt: position.slashedAt || null,
      txHash: position.txHash || null,
      releaseTxHash: position.releaseTxHash || null,
      slashTxHash: position.slashTxHash || null,
    })
    .onConflictDoUpdate({
      target: stakePositions.id,
      set: {
        stakeRequirementId: position.stakeRequirementId,
        jobId: position.jobId,
        staker: position.staker,
        chainId: position.chainId,
        token: position.token,
        amount: position.amount,
        status: position.status,
        lockedAt: position.lockedAt,
        releasedAt: position.releasedAt || null,
        slashedAt: position.slashedAt || null,
        txHash: position.txHash || null,
        releaseTxHash: position.releaseTxHash || null,
        slashTxHash: position.slashTxHash || null,
      },
    })
    .run();
};

export const updateStakePosition = async (position: StakePosition): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.update(stakePositions)
    .set({
      stakeRequirementId: position.stakeRequirementId,
      jobId: position.jobId,
      staker: position.staker,
      chainId: position.chainId,
      token: position.token,
      amount: position.amount,
      status: position.status,
      lockedAt: position.lockedAt,
      releasedAt: position.releasedAt || null,
      slashedAt: position.slashedAt || null,
      txHash: position.txHash || null,
      releaseTxHash: position.releaseTxHash || null,
      slashTxHash: position.slashTxHash || null,
    })
    .where(eq(stakePositions.id, position.id))
    .run();
};

export const writeSwarmSplit = async (split: SwarmSplit): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.insert(swarmSplits)
    .values({
      id: split.id,
      jobId: split.jobId,
      payer: split.payer,
      totalAmount: split.totalAmount,
      chainId: split.chainId,
      token: split.token,
      participants: JSON.stringify(split.participants),
      status: split.status,
      createdAt: split.createdAt,
      distributedAt: split.distributedAt || null,
    })
    .onConflictDoUpdate({
      target: swarmSplits.id,
      set: {
        jobId: split.jobId,
        payer: split.payer,
        totalAmount: split.totalAmount,
        chainId: split.chainId,
        token: split.token,
        participants: JSON.stringify(split.participants),
        status: split.status,
        distributedAt: split.distributedAt || null,
      },
    })
    .run();
};

export const updateSwarmSplit = async (split: SwarmSplit): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.update(swarmSplits)
    .set({
      jobId: split.jobId,
      payer: split.payer,
      totalAmount: split.totalAmount,
      chainId: split.chainId,
      token: split.token,
      participants: JSON.stringify(split.participants),
      status: split.status,
      distributedAt: split.distributedAt || null,
    })
    .where(eq(swarmSplits.id, split.id))
    .run();
};

export const writeSettlement = async (settlement: SettlementIntent): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.insert(pendingSettlements)
    .values({
      id: settlement.id,
      type: settlement.type,
      ledgerEntryId: settlement.ledgerEntryId,
      invoice: settlement.invoice ? JSON.stringify(settlement.invoice) : null,
      priority: settlement.priority,
      createdAt: settlement.createdAt,
      retryCount: settlement.retryCount,
      maxRetries: settlement.maxRetries,
    })
    .onConflictDoUpdate({
      target: pendingSettlements.id,
      set: {
        type: settlement.type,
        ledgerEntryId: settlement.ledgerEntryId,
        invoice: settlement.invoice ? JSON.stringify(settlement.invoice) : null,
        priority: settlement.priority,
        retryCount: settlement.retryCount,
        maxRetries: settlement.maxRetries,
      },
    })
    .run();
};

export const removeSettlement = async (settlementId: string): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.delete(pendingSettlements).where(eq(pendingSettlements.id, settlementId)).run();
};

export const updateSettlement = async (settlement: SettlementIntent): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.update(pendingSettlements)
    .set({
      type: settlement.type,
      ledgerEntryId: settlement.ledgerEntryId,
      invoice: settlement.invoice ? JSON.stringify(settlement.invoice) : null,
      priority: settlement.priority,
      retryCount: settlement.retryCount,
      maxRetries: settlement.maxRetries,
    })
    .where(eq(pendingSettlements.id, settlement.id))
    .run();
};

export const isPaymentProofProcessed = async (txHash: string, chainId: number): Promise<boolean> => {
  const db = getDb();
  if (!db) {
    return false;
  }
  try {
    const rows = db
      .select()
      .from(processedPaymentProofs)
      .where(eq(processedPaymentProofs.txHash, txHash))
      .all();
    return rows.length > 0 && rows[0].chainId === chainId;
  } catch (error) {
    if (isNoSuchTableError(error)) {
      return false;
    }
    throw error;
  }
};

export const markPaymentProofProcessed = async (
  txHash: string,
  chainId: number,
  invoiceId: string
): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.insert(processedPaymentProofs)
    .values({
      txHash,
      chainId,
      invoiceId,
      processedAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
};

export const writeTimedOutPayment = async (
  invoice: Invoice,
  timedOutAt: number
): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.insert(timedOutPayments)
    .values({
      invoiceId: invoice.id,
      jobId: invoice.jobId,
      chainId: invoice.chainId,
      amount: invoice.amount,
      token: invoice.token,
      recipient: invoice.recipient,
      validUntil: invoice.validUntil,
      tokenAddress: invoice.tokenAddress ?? null,
      timedOutAt,
      status: 'pending',
    })
    .onConflictDoUpdate({
      target: timedOutPayments.invoiceId,
      set: {
        jobId: invoice.jobId,
        chainId: invoice.chainId,
        amount: invoice.amount,
        token: invoice.token,
        recipient: invoice.recipient,
        validUntil: invoice.validUntil,
        tokenAddress: invoice.tokenAddress ?? null,
        timedOutAt,
        status: 'pending',
      },
    })
    .run();
};

export const getTimedOutPayment = async (
  invoiceId: string
): Promise<TimedOutPaymentRecord | null> => {
  const db = getDb();
  if (!db) {
    return null;
  }
  try {
    const rows = db
      .select()
      .from(timedOutPayments)
      .where(eq(timedOutPayments.invoiceId, invoiceId))
      .all();
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0];
    return {
      invoice: {
        id: row.invoiceId,
        jobId: row.jobId,
        chainId: row.chainId,
        amount: row.amount,
        token: row.token,
        recipient: row.recipient,
        validUntil: row.validUntil,
        tokenAddress: toHexAddress(row.tokenAddress),
      },
      timedOutAt: row.timedOutAt,
      status: row.status as TimedOutPaymentRecord['status'],
      recoveredAt: row.recoveredAt ?? undefined,
      txHash: row.txHash ?? undefined,
    };
  } catch (error) {
    if (isNoSuchTableError(error)) {
      return null;
    }
    throw error;
  }
};

export const loadPendingTimedOutPayments = async (): Promise<TimedOutPaymentRecord[]> => {
  const db = getDb();
  if (!db) {
    return [];
  }
  try {
    const rows = db
      .select()
      .from(timedOutPayments)
      .where(eq(timedOutPayments.status, 'pending'))
      .all();
    return rows.map((row) => ({
      invoice: {
        id: row.invoiceId,
        jobId: row.jobId,
        chainId: row.chainId,
        amount: row.amount,
        token: row.token,
        recipient: row.recipient,
        validUntil: row.validUntil,
        tokenAddress: toHexAddress(row.tokenAddress),
      },
      timedOutAt: row.timedOutAt,
      status: row.status as TimedOutPaymentRecord['status'],
      recoveredAt: row.recoveredAt ?? undefined,
      txHash: row.txHash ?? undefined,
    }));
  } catch (error) {
    if (isNoSuchTableError(error)) {
      return [];
    }
    throw error;
  }
};

export const markTimedOutPaymentRecovered = async (
  invoiceId: string,
  txHash: string
): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.update(timedOutPayments)
    .set({
      status: 'recovered',
      recoveredAt: Date.now(),
      txHash,
    })
    .where(eq(timedOutPayments.invoiceId, invoiceId))
    .run();
};

export const markTimedOutPaymentExpired = async (invoiceId: string): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.update(timedOutPayments)
    .set({ status: 'expired' })
    .where(eq(timedOutPayments.invoiceId, invoiceId))
    .run();
};

export const deleteTimedOutPayment = async (invoiceId: string): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.delete(timedOutPayments)
    .where(eq(timedOutPayments.invoiceId, invoiceId))
    .run();
};

export const processPaymentRecovery = async (
  txHash: string,
  chainId: number,
  invoiceId: string
): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  runTransaction(() => {
    db.insert(processedPaymentProofs)
      .values({
        txHash,
        chainId,
        invoiceId,
        processedAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
    db.update(timedOutPayments)
      .set({
        status: 'recovered',
        recoveredAt: Date.now(),
        txHash,
      })
      .where(eq(timedOutPayments.invoiceId, invoiceId))
      .run();
  });
};

export const createAndDistributeSwarmSplit = async (
  initialSplit: SwarmSplit,
  updatedSplit: SwarmSplit
): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  runTransaction(() => {
    db.insert(swarmSplits)
      .values({
        id: initialSplit.id,
        jobId: initialSplit.jobId,
        payer: initialSplit.payer,
        totalAmount: initialSplit.totalAmount,
        chainId: initialSplit.chainId,
        token: initialSplit.token,
        participants: JSON.stringify(initialSplit.participants),
        status: initialSplit.status,
        createdAt: initialSplit.createdAt,
        distributedAt: initialSplit.distributedAt || null,
      })
      .onConflictDoUpdate({
        target: swarmSplits.id,
        set: {
          jobId: initialSplit.jobId,
          payer: initialSplit.payer,
          totalAmount: initialSplit.totalAmount,
          chainId: initialSplit.chainId,
          token: initialSplit.token,
          participants: JSON.stringify(initialSplit.participants),
          status: initialSplit.status,
          distributedAt: initialSplit.distributedAt || null,
        },
      })
      .run();
    db.update(swarmSplits)
      .set({
        jobId: updatedSplit.jobId,
        payer: updatedSplit.payer,
        totalAmount: updatedSplit.totalAmount,
        chainId: updatedSplit.chainId,
        token: updatedSplit.token,
        participants: JSON.stringify(updatedSplit.participants),
        status: updatedSplit.status,
        distributedAt: updatedSplit.distributedAt || null,
      })
      .where(eq(swarmSplits.id, updatedSplit.id))
      .run();
  });
};

export interface ExpectedInvoiceRecord {
  jobId: string;
  expectedRecipient: string;
  createdAt: number;
  expiresAt: number;
}

export const writeExpectedInvoice = async (
  jobId: string,
  expectedRecipient: string,
  expiresAt: number
): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.insert(expectedInvoices)
    .values({
      jobId,
      expectedRecipient,
      createdAt: Date.now(),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: expectedInvoices.jobId,
      set: {
        expectedRecipient,
        expiresAt,
      },
    })
    .run();
};

export const getExpectedInvoice = async (
  jobId: string
): Promise<ExpectedInvoiceRecord | null> => {
  const db = getDb();
  if (!db) {
    return null;
  }
  try {
    const rows = db
      .select()
      .from(expectedInvoices)
      .where(eq(expectedInvoices.jobId, jobId))
      .all();
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0];
    if (row.expiresAt < Date.now()) {
      return null;
    }
    return {
      jobId: row.jobId,
      expectedRecipient: row.expectedRecipient,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  } catch (error) {
    if (isNoSuchTableError(error)) {
      return null;
    }
    throw error;
  }
};

export const deleteExpectedInvoice = async (jobId: string): Promise<void> => {
  await ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.delete(expectedInvoices)
    .where(eq(expectedInvoices.jobId, jobId))
    .run();
};
