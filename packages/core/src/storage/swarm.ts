import { eq } from 'drizzle-orm';
import { swarmSplits, type SwarmSplit } from './schema';
import { getDb, requireDb, ensureDbInitialized, isNoSuchTableError, handleLoadError, runTransaction } from './db';

export const loadSwarmSplits = async (): Promise<Record<string, SwarmSplit>> => {
  const db = getDb();
  if (!db) return {};
  try {
    const rows = db.select().from(swarmSplits).all();
    const result: Record<string, SwarmSplit> = {};
    for (const row of rows) result[row.id] = row;
    return result;
  } catch (error) {
    if (isNoSuchTableError(error)) return {};
    return handleLoadError(error, 'swarm splits');
  }
};

export const writeSwarmSplit = async (e: SwarmSplit): Promise<void> => {
  await ensureDbInitialized();
  requireDb().insert(swarmSplits).values(e).onConflictDoUpdate({ target: swarmSplits.id, set: e }).run();
};

export const updateSwarmSplit = async (e: SwarmSplit): Promise<void> => {
  await ensureDbInitialized();
  requireDb().update(swarmSplits).set(e).where(eq(swarmSplits.id, e.id)).run();
};

export const createAndDistributeSwarmSplit = async (initial: SwarmSplit, updated: SwarmSplit): Promise<void> => {
  await ensureDbInitialized();
  const db = requireDb();
  runTransaction(() => {
    db.insert(swarmSplits).values(initial).onConflictDoUpdate({ target: swarmSplits.id, set: initial }).run();
    db.update(swarmSplits).set(updated).where(eq(swarmSplits.id, updated.id)).run();
  });
};
