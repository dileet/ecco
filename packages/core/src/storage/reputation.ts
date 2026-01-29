import { eq } from 'drizzle-orm';
import { localReputation, type LocalReputationRecord } from './schema';
import { getDb, isNoSuchTableError, handleLoadError } from './db';

export async function loadLocalReputation(): Promise<LocalReputationRecord[]> {
  const db = getDb();
  if (!db) return [];

  try {
    return db.select().from(localReputation).all();
  } catch (error) {
    if (isNoSuchTableError(error)) return [];
    return handleLoadError(error, 'local reputation');
  }
}

export async function writeLocalReputation(record: LocalReputationRecord): Promise<void> {
  const db = getDb();
  if (!db) return;

  try {
    db.insert(localReputation)
      .values(record)
      .onConflictDoUpdate({
        target: localReputation.peerId,
        set: {
          walletAddress: record.walletAddress,
          agentId: record.agentId,
          localScore: record.localScore,
          totalJobs: record.totalJobs,
          successfulJobs: record.successfulJobs,
          failedJobs: record.failedJobs,
          lastSyncedAt: record.lastSyncedAt,
          lastInteractionAt: record.lastInteractionAt,
        },
      })
      .run();
  } catch (error) {
    if (isNoSuchTableError(error)) return;
    throw error;
  }
}

export async function updateLocalReputation(
  peerId: string,
  updates: Partial<Omit<LocalReputationRecord, 'peerId'>>
): Promise<void> {
  const db = getDb();
  if (!db) return;

  try {
    db.update(localReputation)
      .set(updates)
      .where(eq(localReputation.peerId, peerId))
      .run();
  } catch (error) {
    if (isNoSuchTableError(error)) return;
    throw error;
  }
}

export async function deleteLocalReputation(peerId: string): Promise<void> {
  const db = getDb();
  if (!db) return;

  try {
    db.delete(localReputation)
      .where(eq(localReputation.peerId, peerId))
      .run();
  } catch (error) {
    if (isNoSuchTableError(error)) return;
    throw error;
  }
}

export async function deleteStaleReputation(olderThanMs: number): Promise<void> {
  const db = getDb();
  if (!db) return;

  const threshold = Date.now() - olderThanMs;

  try {
    db.delete(localReputation)
      .where(eq(localReputation.lastInteractionAt, threshold))
      .run();
  } catch (error) {
    if (isNoSuchTableError(error)) return;
    throw error;
  }
}
