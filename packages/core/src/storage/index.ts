import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { eq } from 'drizzle-orm';
import {
  escrowAgreements,
  paymentLedger,
  streamingChannels,
  stakePositions,
  swarmSplits,
  pendingSettlements,
} from './schema';
import type {
  EscrowAgreement,
  PaymentLedgerEntry,
  StreamingAgreement,
  StakePosition,
  SwarmSplit,
  SettlementIntent,
} from '../types';

let dbInstance: ReturnType<typeof drizzle> | null = null;
let sqliteDb: Database | null = null;
let currentNodeId: string | null = null;

const getEccoDir = (): string => path.resolve(homedir(), '.ecco');
const getDbPath = (nodeId: string): string => path.join(getEccoDir(), `${nodeId}.sqlite`);

const getDb = (): ReturnType<typeof drizzle> | null => dbInstance;

const ensureDbInitialized = (): void => {
  if (dbInstance) {
    return;
  }
  if (!currentNodeId) {
    throw new Error('Node ID not set');
  }
  const dbPath = getDbPath(currentNodeId);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  sqliteDb = new Database(dbPath);
  dbInstance = drizzle({ client: sqliteDb });
};

const isNoSuchTableError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('no such table');

export const initialize = async (nodeId: string): Promise<void> => {
  currentNodeId = nodeId;
  const dbPath = getDbPath(nodeId);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(dbPath)) {
    return;
  }

  sqliteDb = new Database(dbPath);
  dbInstance = drizzle({ client: sqliteDb });
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
  ensureDbInitialized();
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
  ensureDbInitialized();
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

export const writePaymentLedgerEntry = async (entry: PaymentLedgerEntry): Promise<void> => {
  ensureDbInitialized();
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
  ensureDbInitialized();
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
  ensureDbInitialized();
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
  ensureDbInitialized();
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
  ensureDbInitialized();
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
  ensureDbInitialized();
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
  ensureDbInitialized();
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
  ensureDbInitialized();
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
  ensureDbInitialized();
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
  ensureDbInitialized();
  const db = getDb();
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.delete(pendingSettlements).where(eq(pendingSettlements.id, settlementId)).run();
};

export const updateSettlement = async (settlement: SettlementIntent): Promise<void> => {
  ensureDbInitialized();
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
