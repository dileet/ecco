import { and, eq } from 'drizzle-orm';
import { escrowAgreements, type EscrowAgreement } from './schema';
import { getDb, requireDb, ensureDbInitialized, isNoSuchTableError, handleLoadError } from './db';

export const loadEscrowAgreements = async (): Promise<Record<string, EscrowAgreement>> => {
  const db = getDb();
  if (!db) return {};
  try {
    const rows = db.select().from(escrowAgreements).all();
    const result: Record<string, EscrowAgreement> = {};
    for (const row of rows) result[row.id] = row;
    return result;
  } catch (error) {
    if (isNoSuchTableError(error)) return {};
    return handleLoadError(error, 'escrow agreements');
  }
};

export const writeEscrowAgreement = async (e: EscrowAgreement): Promise<void> => {
  await ensureDbInitialized();
  await requireDb().insert(escrowAgreements).values(e).onConflictDoUpdate({ target: escrowAgreements.id, set: e });
};

export const updateEscrowAgreement = async (e: EscrowAgreement): Promise<void> => {
  await ensureDbInitialized();
  requireDb().update(escrowAgreements).set(e).where(eq(escrowAgreements.id, e.id)).run();
};

export const updateEscrowAgreementIfUnchanged = async (
  e: EscrowAgreement,
  expectedMilestones: EscrowAgreement['milestones']
): Promise<boolean> => {
  await ensureDbInitialized();
  const updated = requireDb().update(escrowAgreements)
    .set(e)
    .where(and(eq(escrowAgreements.id, e.id), eq(escrowAgreements.milestones, expectedMilestones)))
    .returning({ id: escrowAgreements.id })
    .all();
  return updated.length > 0;
};
