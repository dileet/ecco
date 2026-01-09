import { eq } from 'drizzle-orm';
import {
  paymentLedger,
  pendingSettlements,
  processedPaymentProofs,
  timedOutPayments,
  type PaymentLedgerEntry,
  type SettlementIntent,
  type TimedOutPayment,
  type StoredInvoice,
} from './schema';
import { getDb, requireDb, ensureDbInitialized, isNoSuchTableError, handleLoadError, runTransaction } from './db';

export const loadPaymentLedger = async (): Promise<Record<string, PaymentLedgerEntry>> => {
  const db = getDb();
  if (!db) return {};
  try {
    const rows = db.select().from(paymentLedger).all();
    const result: Record<string, PaymentLedgerEntry> = {};
    for (const row of rows) result[row.id] = row;
    return result;
  } catch (error) {
    if (isNoSuchTableError(error)) return {};
    return handleLoadError(error, 'payment ledger');
  }
};

export const writePaymentLedgerEntry = async (e: PaymentLedgerEntry): Promise<void> => {
  await ensureDbInitialized();
  requireDb().insert(paymentLedger).values(e).onConflictDoUpdate({ target: paymentLedger.id, set: e }).run();
};

export const updatePaymentLedgerEntry = async (e: PaymentLedgerEntry): Promise<void> => {
  await ensureDbInitialized();
  requireDb().update(paymentLedger).set(e).where(eq(paymentLedger.id, e.id)).run();
};

export const loadPendingSettlements = async (): Promise<SettlementIntent[]> => {
  const db = getDb();
  if (!db) return [];
  try {
    return db.select().from(pendingSettlements).all();
  } catch (error) {
    if (isNoSuchTableError(error)) return [];
    return handleLoadError(error, 'pending settlements');
  }
};

export const writeSettlement = async (e: SettlementIntent): Promise<void> => {
  await ensureDbInitialized();
  requireDb().insert(pendingSettlements).values(e).onConflictDoUpdate({ target: pendingSettlements.id, set: e }).run();
};

export const removeSettlement = async (id: string): Promise<void> => {
  await ensureDbInitialized();
  requireDb().delete(pendingSettlements).where(eq(pendingSettlements.id, id)).run();
};

export const updateSettlement = async (e: SettlementIntent): Promise<void> => {
  await ensureDbInitialized();
  requireDb().update(pendingSettlements).set(e).where(eq(pendingSettlements.id, e.id)).run();
};

export const isPaymentProofProcessed = async (txHash: string, chainId: number): Promise<boolean> => {
  const db = getDb();
  if (!db) return false;
  try {
    const rows = db.select().from(processedPaymentProofs).where(eq(processedPaymentProofs.txHash, txHash)).all();
    return rows.length > 0 && rows[0].chainId === chainId;
  } catch (error) {
    if (isNoSuchTableError(error)) return false;
    throw error;
  }
};

export const markPaymentProofProcessed = async (txHash: string, chainId: number, invoiceId: string): Promise<void> => {
  await ensureDbInitialized();
  requireDb().insert(processedPaymentProofs)
    .values({ txHash, chainId, invoiceId, processedAt: Date.now() })
    .onConflictDoNothing().run();
};

export const writeTimedOutPayment = async (invoice: StoredInvoice, timedOutAt: number): Promise<void> => {
  await ensureDbInitialized();
  const values: TimedOutPayment = {
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
    recoveredAt: null,
    txHash: null,
  };
  requireDb().insert(timedOutPayments).values(values).onConflictDoUpdate({ target: timedOutPayments.invoiceId, set: values }).run();
};

export const getTimedOutPayment = async (invoiceId: string): Promise<TimedOutPayment | null> => {
  const db = getDb();
  if (!db) return null;
  try {
    const rows = db.select().from(timedOutPayments).where(eq(timedOutPayments.invoiceId, invoiceId)).all();
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    if (isNoSuchTableError(error)) return null;
    throw error;
  }
};

export const loadPendingTimedOutPayments = async (): Promise<TimedOutPayment[]> => {
  const db = getDb();
  if (!db) return [];
  try {
    return db.select().from(timedOutPayments).where(eq(timedOutPayments.status, 'pending')).all();
  } catch (error) {
    if (isNoSuchTableError(error)) return [];
    throw error;
  }
};

export const markTimedOutPaymentRecovered = async (invoiceId: string, txHash: string): Promise<void> => {
  await ensureDbInitialized();
  requireDb().update(timedOutPayments)
    .set({ status: 'recovered', recoveredAt: Date.now(), txHash })
    .where(eq(timedOutPayments.invoiceId, invoiceId)).run();
};

export const markTimedOutPaymentExpired = async (invoiceId: string): Promise<void> => {
  await ensureDbInitialized();
  requireDb().update(timedOutPayments).set({ status: 'expired' }).where(eq(timedOutPayments.invoiceId, invoiceId)).run();
};

export const deleteTimedOutPayment = async (invoiceId: string): Promise<void> => {
  await ensureDbInitialized();
  requireDb().delete(timedOutPayments).where(eq(timedOutPayments.invoiceId, invoiceId)).run();
};

export const processPaymentRecovery = async (txHash: string, chainId: number, invoiceId: string): Promise<void> => {
  await ensureDbInitialized();
  const db = requireDb();
  runTransaction(() => {
    db.insert(processedPaymentProofs)
      .values({ txHash, chainId, invoiceId, processedAt: Date.now() })
      .onConflictDoNothing().run();
    db.update(timedOutPayments)
      .set({ status: 'recovered', recoveredAt: Date.now(), txHash })
      .where(eq(timedOutPayments.invoiceId, invoiceId)).run();
  });
};
