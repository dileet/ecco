import { eq } from 'drizzle-orm';
import { streamingChannels, type StreamingAgreement } from './schema';
import { getDb, requireDb, ensureDbInitialized, isNoSuchTableError, handleLoadError } from './db';

export const loadStreamingChannels = async (): Promise<Record<string, StreamingAgreement>> => {
  const db = getDb();
  if (!db) throw new Error('Database not initialized when loading streaming channels');
  try {
    const rows = db.select().from(streamingChannels).all();
    const result: Record<string, StreamingAgreement> = {};
    for (const row of rows) result[row.id] = row;
    return result;
  } catch (error) {
    if (isNoSuchTableError(error)) return {};
    return handleLoadError(error, 'streaming channels');
  }
};

export const writeStreamingChannel = async (e: StreamingAgreement): Promise<void> => {
  await ensureDbInitialized();
  requireDb().insert(streamingChannels).values(e).onConflictDoUpdate({ target: streamingChannels.id, set: e }).run();
};

export const updateStreamingChannel = async (e: StreamingAgreement): Promise<void> => {
  await ensureDbInitialized();
  requireDb().update(streamingChannels).set(e).where(eq(streamingChannels.id, e.id)).run();
};
