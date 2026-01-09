import { eq } from 'drizzle-orm';
import { stakePositions, type StakePosition } from './schema';
import { getDb, requireDb, ensureDbInitialized, isNoSuchTableError, handleLoadError } from './db';

export const loadStakePositions = async (): Promise<Record<string, StakePosition>> => {
  const db = getDb();
  if (!db) return {};
  try {
    const rows = db.select().from(stakePositions).all();
    const result: Record<string, StakePosition> = {};
    for (const row of rows) result[row.id] = row;
    return result;
  } catch (error) {
    if (isNoSuchTableError(error)) return {};
    return handleLoadError(error, 'stake positions');
  }
};

export const writeStakePosition = async (e: StakePosition): Promise<void> => {
  await ensureDbInitialized();
  requireDb().insert(stakePositions).values(e).onConflictDoUpdate({ target: stakePositions.id, set: e }).run();
};

export const updateStakePosition = async (e: StakePosition): Promise<void> => {
  await ensureDbInitialized();
  requireDb().update(stakePositions).set(e).where(eq(stakePositions.id, e.id)).run();
};
