import { Effect, Context, Layer } from 'effect';
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

export class StorageError extends Error {
  readonly _tag = 'StorageError';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface StorageService {
  readonly initialize: (nodeId: string) => Effect.Effect<void, StorageError>;
  readonly loadEscrowAgreements: () => Effect.Effect<Map<string, EscrowAgreement>, StorageError>;
  readonly loadPaymentLedger: () => Effect.Effect<Map<string, PaymentLedgerEntry>, StorageError>;
  readonly loadStreamingChannels: () => Effect.Effect<Map<string, StreamingAgreement>, StorageError>;
  readonly loadStakePositions: () => Effect.Effect<Map<string, StakePosition>, StorageError>;
  readonly loadSwarmSplits: () => Effect.Effect<Map<string, SwarmSplit>, StorageError>;
  readonly loadPendingSettlements: () => Effect.Effect<SettlementIntent[], StorageError>;
  readonly writeEscrowAgreement: (agreement: EscrowAgreement) => Effect.Effect<void, StorageError>;
  readonly updateEscrowAgreement: (agreement: EscrowAgreement) => Effect.Effect<void, StorageError>;
  readonly writePaymentLedgerEntry: (entry: PaymentLedgerEntry) => Effect.Effect<void, StorageError>;
  readonly updatePaymentLedgerEntry: (entry: PaymentLedgerEntry) => Effect.Effect<void, StorageError>;
  readonly writeStreamingChannel: (channel: StreamingAgreement) => Effect.Effect<void, StorageError>;
  readonly updateStreamingChannel: (channel: StreamingAgreement) => Effect.Effect<void, StorageError>;
  readonly writeStakePosition: (position: StakePosition) => Effect.Effect<void, StorageError>;
  readonly updateStakePosition: (position: StakePosition) => Effect.Effect<void, StorageError>;
  readonly writeSwarmSplit: (split: SwarmSplit) => Effect.Effect<void, StorageError>;
  readonly updateSwarmSplit: (split: SwarmSplit) => Effect.Effect<void, StorageError>;
  readonly writeSettlement: (settlement: SettlementIntent) => Effect.Effect<void, StorageError>;
  readonly removeSettlement: (settlementId: string) => Effect.Effect<void, StorageError>;
  readonly updateSettlement: (settlement: SettlementIntent) => Effect.Effect<void, StorageError>;
}

export const StorageService = Context.GenericTag<StorageService>('@ecco/core/StorageService');

const getDbPath = (nodeId: string): string => {
  return `.ecco/${nodeId}.sqlite`;
};

const makeStorageService = (): StorageService => {
  let dbInstance: ReturnType<typeof drizzle> | null = null;
  let sqliteDb: Database | null = null;
  let currentNodeId: string | null = null;

  const getDb = (): ReturnType<typeof drizzle> | null => {
    return dbInstance;
  };

  const ensureDbInitialized = (): Effect.Effect<void, StorageError> =>
    Effect.gen(function* () {
      if (dbInstance) {
        return;
      }
      if (!currentNodeId) {
        throw new StorageError('Node ID not set');
      }
      const dbPath = getDbPath(currentNodeId);
      const fs = require('fs');
      const path = require('path');
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      sqliteDb = yield* Effect.try({
        try: () => new Database(dbPath),
        catch: (error) => new StorageError('Failed to open database', error),
      });
      dbInstance = drizzle({ client: sqliteDb });
    });

  return {
    initialize: (nodeId: string) =>
      Effect.gen(function* () {
        currentNodeId = nodeId;
        const dbPath = getDbPath(nodeId);
        yield* Effect.sync(() => {
          const fs = require('fs');
          const path = require('path');
          const dir = path.dirname(dbPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
        });
        
        const fs = require('fs');
        if (!fs.existsSync(dbPath)) {
          return;
        }
        
        sqliteDb = yield* Effect.try({
          try: () => new Database(dbPath),
          catch: (error) => new StorageError('Failed to open database', error),
        });
        dbInstance = drizzle({ client: sqliteDb });
      }),

    loadEscrowAgreements: () =>
      Effect.gen(function* () {
        const db = getDb();
        if (!db) {
          return new Map();
        }
        const rows = yield* Effect.try({
          try: () => db.select().from(escrowAgreements).all(),
          catch: (error) => new StorageError('Failed to load escrow agreements', error),
        }).pipe(
          Effect.catchAll((error) => {
            if (error instanceof StorageError && error.cause instanceof Error && error.cause.message.includes('no such table')) {
              return Effect.succeed([]);
            }
            return Effect.fail(error);
          })
        );
        const map = new Map<string, EscrowAgreement>();
        for (const row of rows) {
          map.set(row.id, {
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
          });
        }
        return map;
      }),

    loadPaymentLedger: () =>
      Effect.gen(function* () {
        const db = getDb();
        if (!db) {
          return new Map();
        }
        const rows = yield* Effect.try({
          try: () => db.select().from(paymentLedger).all(),
          catch: (error) => new StorageError('Failed to load payment ledger', error),
        }).pipe(
          Effect.catchAll((error) => {
            if (error instanceof StorageError && error.cause instanceof Error && error.cause.message.includes('no such table')) {
              return Effect.succeed([]);
            }
            return Effect.fail(error);
          })
        );
        const map = new Map<string, PaymentLedgerEntry>();
        for (const row of rows) {
          map.set(row.id, {
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
          });
        }
        return map;
      }),

    loadStreamingChannels: () =>
      Effect.gen(function* () {
        const db = getDb();
        if (!db) {
          return new Map();
        }
        const rows = yield* Effect.try({
          try: () => db.select().from(streamingChannels).all(),
          catch: (error) => new StorageError('Failed to load streaming channels', error),
        }).pipe(
          Effect.catchAll((error) => {
            if (error instanceof StorageError && error.cause instanceof Error && error.cause.message.includes('no such table')) {
              return Effect.succeed([]);
            }
            return Effect.fail(error);
          })
        );
        const map = new Map<string, StreamingAgreement>();
        for (const row of rows) {
          map.set(row.id, {
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
          });
        }
        return map;
      }),

    loadStakePositions: () =>
      Effect.gen(function* () {
        const db = getDb();
        if (!db) {
          return new Map();
        }
        const rows = yield* Effect.try({
          try: () => db.select().from(stakePositions).all(),
          catch: (error) => new StorageError('Failed to load stake positions', error),
        }).pipe(
          Effect.catchAll((error) => {
            if (error instanceof StorageError && error.cause instanceof Error && error.cause.message.includes('no such table')) {
              return Effect.succeed([]);
            }
            return Effect.fail(error);
          })
        );
        const map = new Map<string, StakePosition>();
        for (const row of rows) {
          map.set(row.id, {
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
          });
        }
        return map;
      }),

    loadSwarmSplits: () =>
      Effect.gen(function* () {
        const db = getDb();
        if (!db) {
          return new Map();
        }
        const rows = yield* Effect.try({
          try: () => db.select().from(swarmSplits).all(),
          catch: (error) => new StorageError('Failed to load swarm splits', error),
        }).pipe(
          Effect.catchAll((error) => {
            if (error instanceof StorageError && error.cause instanceof Error && error.cause.message.includes('no such table')) {
              return Effect.succeed([]);
            }
            return Effect.fail(error);
          })
        );
        const map = new Map<string, SwarmSplit>();
        for (const row of rows) {
          map.set(row.id, {
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
          });
        }
        return map;
      }),

    loadPendingSettlements: () =>
      Effect.gen(function* () {
        const db = getDb();
        if (!db) {
          return [];
        }
        const rows = yield* Effect.try({
          try: () => db.select().from(pendingSettlements).all(),
          catch: (error) => new StorageError('Failed to load pending settlements', error),
        }).pipe(
          Effect.catchAll((error) => {
            if (error instanceof StorageError && error.cause instanceof Error && error.cause.message.includes('no such table')) {
              return Effect.succeed([]);
            }
            return Effect.fail(error);
          })
        );
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
      }),

    writeEscrowAgreement: (agreement: EscrowAgreement) =>
      Effect.gen(function* () {
        yield* ensureDbInitialized();
        const db = getDb();
        if (!db) {
          throw new StorageError('Database not initialized');
        }
        yield* Effect.tryPromise({
          try: () =>
            db.insert(escrowAgreements)
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
              }),
          catch: (error) => new StorageError('Failed to write escrow agreement', error),
        });
      }),

    updateEscrowAgreement: (agreement: EscrowAgreement) =>
      Effect.gen(function* () {
        yield* ensureDbInitialized();
        const db = getDb();
        if (!db) {
          throw new StorageError('Database not initialized');
        }
        yield* Effect.tryPromise({
          try: () =>
            db.update(escrowAgreements)
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
              .where(eq(escrowAgreements.id, agreement.id)),
          catch: (error) => new StorageError('Failed to update escrow agreement', error),
        });
      }),

    writePaymentLedgerEntry: (entry: PaymentLedgerEntry) =>
      Effect.gen(function* () {
        yield* ensureDbInitialized();
        const db = getDb();
        if (!db) {
          throw new StorageError('Database not initialized');
        }
        yield* Effect.try({
          try: () => {
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
          },
          catch: (error) => new StorageError('Failed to write payment ledger entry', error),
        });
      }),

    updatePaymentLedgerEntry: (entry: PaymentLedgerEntry) =>
      Effect.gen(function* () {
        yield* ensureDbInitialized();
        const db = getDb();
        if (!db) {
          throw new StorageError('Database not initialized');
        }
        yield* Effect.try({
          try: () => {
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
          },
          catch: (error) => new StorageError('Failed to update payment ledger entry', error),
        });
      }),

    writeStreamingChannel: (channel: StreamingAgreement) =>
      Effect.gen(function* () {
        yield* ensureDbInitialized();
        const db = getDb();
        if (!db) {
          throw new StorageError('Database not initialized');
        }
        yield* Effect.try({
          try: () => {
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
          },
          catch: (error) => new StorageError('Failed to write streaming channel', error),
        });
      }),

    updateStreamingChannel: (channel: StreamingAgreement) =>
      Effect.gen(function* () {
        yield* ensureDbInitialized();
        const db = getDb();
        if (!db) {
          throw new StorageError('Database not initialized');
        }
        yield* Effect.try({
          try: () => {
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
          },
          catch: (error) => new StorageError('Failed to update streaming channel', error),
        });
      }),

    writeStakePosition: (position: StakePosition) =>
      Effect.gen(function* () {
        yield* ensureDbInitialized();
        const db = getDb();
        if (!db) {
          throw new StorageError('Database not initialized');
        }
        yield* Effect.try({
          try: () => {
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
          },
          catch: (error) => new StorageError('Failed to write stake position', error),
        });
      }),

    updateStakePosition: (position: StakePosition) =>
      Effect.gen(function* () {
        yield* ensureDbInitialized();
        const db = getDb();
        if (!db) {
          throw new StorageError('Database not initialized');
        }
        yield* Effect.try({
          try: () => {
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
          },
          catch: (error) => new StorageError('Failed to update stake position', error),
        });
      }),

    writeSwarmSplit: (split: SwarmSplit) =>
      Effect.gen(function* () {
        yield* ensureDbInitialized();
        const db = getDb();
        if (!db) {
          throw new StorageError('Database not initialized');
        }
        yield* Effect.try({
          try: () => {
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
          },
          catch: (error) => new StorageError('Failed to write swarm split', error),
        });
      }),

    updateSwarmSplit: (split: SwarmSplit) =>
      Effect.gen(function* () {
        yield* ensureDbInitialized();
        const db = getDb();
        if (!db) {
          throw new StorageError('Database not initialized');
        }
        yield* Effect.try({
          try: () => {
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
          },
          catch: (error) => new StorageError('Failed to update swarm split', error),
        });
      }),

    writeSettlement: (settlement: SettlementIntent) =>
      Effect.gen(function* () {
        yield* ensureDbInitialized();
        const db = getDb();
        if (!db) {
          throw new StorageError('Database not initialized');
        }
        yield* Effect.try({
          try: () => {
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
          },
          catch: (error) => new StorageError('Failed to write settlement', error),
        });
      }),

    removeSettlement: (settlementId: string) =>
      Effect.gen(function* () {
        yield* ensureDbInitialized();
        const db = getDb();
        if (!db) {
          throw new StorageError('Database not initialized');
        }
        yield* Effect.try({
          try: () => {
            db.delete(pendingSettlements).where(eq(pendingSettlements.id, settlementId)).run();
          },
          catch: (error) => new StorageError('Failed to remove settlement', error),
        });
      }),

    updateSettlement: (settlement: SettlementIntent) =>
      Effect.gen(function* () {
        yield* ensureDbInitialized();
        const db = getDb();
        if (!db) {
          throw new StorageError('Database not initialized');
        }
        yield* Effect.try({
          try: () => {
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
          },
          catch: (error) => new StorageError('Failed to update settlement', error),
        });
      }),
  };
};

export const StorageServiceLive = Layer.succeed(StorageService, makeStorageService());
