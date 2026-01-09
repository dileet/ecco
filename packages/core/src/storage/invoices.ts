import { eq } from 'drizzle-orm';
import { expectedInvoices, type ExpectedInvoice } from './schema';
import { getDb, requireDb, ensureDbInitialized, isNoSuchTableError } from './db';

export const writeExpectedInvoice = async (jobId: string, expectedRecipient: string, expiresAt: number): Promise<void> => {
  await ensureDbInitialized();
  const values = { jobId, expectedRecipient, createdAt: Date.now(), expiresAt };
  requireDb().insert(expectedInvoices).values(values).onConflictDoUpdate({ target: expectedInvoices.jobId, set: { expectedRecipient, expiresAt } }).run();
};

export const getExpectedInvoice = async (jobId: string): Promise<ExpectedInvoice | null> => {
  const db = getDb();
  if (!db) return null;
  try {
    const rows = db.select().from(expectedInvoices).where(eq(expectedInvoices.jobId, jobId)).all();
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row.expiresAt < Date.now()) return null;
    return row;
  } catch (error) {
    if (isNoSuchTableError(error)) return null;
    throw error;
  }
};

export const deleteExpectedInvoice = async (jobId: string): Promise<void> => {
  await ensureDbInitialized();
  requireDb().delete(expectedInvoices).where(eq(expectedInvoices.jobId, jobId)).run();
};
