import type { StateRef, NodeState } from './types';
import type { SettlementIntent, PaymentLedgerEntry, Invoice } from '../types';
import { getState, dequeueSettlement, updateSettlement, removeSettlement } from './state';
import { pay } from '../services/wallet';
import { updatePaymentLedgerEntry } from '../storage';
import { delay, retryWithBackoff } from '../utils/timing';
import { SETTLEMENT } from './constants';

interface WorkerState {
  running: boolean;
  intervalId: ReturnType<typeof setInterval> | null;
}

const workerStates = new WeakMap<StateRef<NodeState>, WorkerState>();

const getLedgerEntryType = (settlementType: SettlementIntent['type']): PaymentLedgerEntry['type'] => {
  switch (settlementType) {
    case 'streaming':
      return 'streaming';
    case 'escrow':
      return 'escrow';
    case 'swarm':
      return 'swarm';
    default:
      return 'standard';
  }
};

const processSettlement = async (
  stateRef: StateRef<NodeState>,
  settlement: SettlementIntent
): Promise<boolean> => {
  const state = getState(stateRef);
  const wallet = state.wallet;

  if (!wallet) {
    return false;
  }

  const storedInvoice = settlement.invoice;
  if (!storedInvoice) {
    await removeSettlement(stateRef, settlement.id);
    return true;
  }

  const invoice: Invoice = {
    ...storedInvoice,
    tokenAddress: storedInvoice.tokenAddress as `0x${string}` | null,
  };

  const maxRetries = settlement.maxRetries || SETTLEMENT.DEFAULT_MAX_RETRIES;

  try {
    const proof = await retryWithBackoff(
      () => pay(wallet, invoice),
      {
        maxAttempts: maxRetries - settlement.retryCount,
        initialDelay: 1000,
        maxDelay: 60000,
        onRetry: async (attempt) => {
          await updateSettlement(stateRef, settlement.id, (s) => ({
            ...s,
            retryCount: settlement.retryCount + attempt,
          }));
        },
      }
    );

    await updatePaymentLedgerEntry({
      id: settlement.ledgerEntryId,
      type: getLedgerEntryType(settlement.type),
      status: 'settled',
      chainId: invoice.chainId,
      token: invoice.token,
      amount: invoice.amount,
      recipient: invoice.recipient,
      payer: '',
      jobId: invoice.jobId,
      createdAt: settlement.createdAt,
      settledAt: Date.now(),
      txHash: proof.txHash,
      metadata: null,
    });

    await removeSettlement(stateRef, settlement.id);
    return true;
  } catch (error) {
    await updatePaymentLedgerEntry({
      id: settlement.ledgerEntryId,
      type: getLedgerEntryType(settlement.type),
      status: 'cancelled',
      chainId: invoice.chainId,
      token: invoice.token,
      amount: invoice.amount,
      recipient: invoice.recipient,
      payer: '',
      jobId: invoice.jobId,
      createdAt: settlement.createdAt,
      txHash: null,
      settledAt: null,
      metadata: { error: error instanceof Error ? error.message : String(error) },
    });

    await removeSettlement(stateRef, settlement.id);
    return false;
  }
};

const processNextSettlement = async (stateRef: StateRef<NodeState>): Promise<void> => {
  const state = getState(stateRef);

  if (state.shuttingDown) {
    return;
  }

  if (state.pendingSettlements.length === 0) {
    return;
  }

  const sortedSettlements = [...state.pendingSettlements].sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    return a.createdAt - b.createdAt;
  });

  const settlement = sortedSettlements[0];
  await processSettlement(stateRef, settlement);
};

const runWorker = async (stateRef: StateRef<NodeState>): Promise<void> => {
  const workerState = workerStates.get(stateRef);
  if (!workerState || !workerState.running) {
    return;
  }

  const state = getState(stateRef);
  if (state.shuttingDown) {
    stopSettlementWorker(stateRef);
    return;
  }

  try {
    await processNextSettlement(stateRef);
  } catch {
  }
};

export const startSettlementWorker = async (stateRef: StateRef<NodeState>): Promise<void> => {
  const existingWorker = workerStates.get(stateRef);
  if (existingWorker?.running) {
    return;
  }

  const workerState: WorkerState = {
    running: true,
    intervalId: setInterval(() => void runWorker(stateRef), SETTLEMENT.WORKER_INTERVAL_MS),
  };

  workerStates.set(stateRef, workerState);

  await runWorker(stateRef);
};

export const stopSettlementWorker = async (stateRef: StateRef<NodeState>): Promise<void> => {
  const workerState = workerStates.get(stateRef);
  if (!workerState) {
    return;
  }

  workerState.running = false;

  if (workerState.intervalId) {
    clearInterval(workerState.intervalId);
    workerState.intervalId = null;
  }

  workerStates.delete(stateRef);
};
