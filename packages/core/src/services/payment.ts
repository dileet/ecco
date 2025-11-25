import { Effect } from 'effect';
import { nanoid } from 'nanoid';
import type {
  Invoice,
  PaymentProof,
  QuoteRequest,
  Message,
  StreamingAgreement,
  EscrowAgreement,
  EscrowMilestone,
  StakeRequirement,
  StakePosition,
  SwarmSplit,
  SwarmParticipant,
  PaymentLedgerEntry,
  SettlementIntent,
} from '../types';
import { InvoiceExpiredError } from '../errors';

export namespace PaymentProtocol {
  export function createInvoice(
    jobId: string,
    chainId: number,
    amount: string,
    token: string,
    recipient: string,
    validUntil: number
  ): Invoice {
    return {
      id: nanoid(),
      jobId,
      chainId,
      amount,
      token,
      recipient,
      validUntil,
    };
  }

  export function validateInvoice(invoice: Invoice): Effect.Effect<boolean, InvoiceExpiredError> {
    return Effect.gen(function* () {
      const now = Date.now();
      if (now > invoice.validUntil) {
        return yield* Effect.fail(
          new InvoiceExpiredError({
            message: 'Invoice has expired',
            invoiceId: invoice.id,
            validUntil: invoice.validUntil,
            currentTime: now,
          })
        );
      }
      return true;
    });
  }

  export async function validateInvoiceAsync(invoice: Invoice): Promise<boolean> {
    try {
      return await Effect.runPromise(validateInvoice(invoice));
    } catch (error) {
      if (error instanceof InvoiceExpiredError) {
        throw error;
      }
      throw error;
    }
  }

  export function createQuoteRequest(
    jobType: string,
    jobParams: Record<string, unknown>,
    preferredChains?: number[]
  ): QuoteRequest {
    return {
      jobType,
      jobParams,
      preferredChains,
    };
  }

  export function createPaymentProof(
    invoiceId: string,
    txHash: string,
    chainId: number
  ): PaymentProof {
    return {
      invoiceId,
      txHash,
      chainId,
    };
  }

  export function createRequestQuoteMessage(
    from: string,
    to: string,
    quoteRequest: QuoteRequest
  ): Message {
    return {
      id: nanoid(),
      from,
      to,
      type: 'request-quote',
      payload: quoteRequest,
      timestamp: Date.now(),
    };
  }

  export function createInvoiceMessage(
    from: string,
    to: string,
    invoice: Invoice
  ): Message {
    return {
      id: nanoid(),
      from,
      to,
      type: 'invoice',
      payload: invoice,
      timestamp: Date.now(),
    };
  }

  export function createPaymentProofMessage(
    from: string,
    to: string,
    paymentProof: PaymentProof
  ): Message {
    return {
      id: nanoid(),
      from,
      to,
      type: 'submit-payment-proof',
      payload: paymentProof,
      timestamp: Date.now(),
    };
  }

  export function createPaymentVerifiedMessage(
    from: string,
    to: string,
    invoiceId: string
  ): Message {
    return {
      id: nanoid(),
      from,
      to,
      type: 'payment-verified',
      payload: { invoiceId },
      timestamp: Date.now(),
    };
  }

  export function createPaymentFailedMessage(
    from: string,
    to: string,
    invoiceId: string,
    reason: string
  ): Message {
    return {
      id: nanoid(),
      from,
      to,
      type: 'payment-failed',
      payload: { invoiceId, reason },
      timestamp: Date.now(),
    };
  }

  export function isRequestQuoteMessage(message: unknown): message is Message & { payload: QuoteRequest } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const msg = message as Record<string, unknown>;
    return (
      msg.type === 'request-quote' &&
      typeof msg.payload === 'object' &&
      msg.payload !== null &&
      'jobType' in msg.payload &&
      'jobParams' in msg.payload
    );
  }

  export function isInvoiceMessage(message: unknown): message is Message & { payload: Invoice } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const msg = message as Record<string, unknown>;
    return (
      msg.type === 'invoice' &&
      typeof msg.payload === 'object' &&
      msg.payload !== null &&
      'id' in msg.payload &&
      'jobId' in msg.payload &&
      'chainId' in msg.payload &&
      'amount' in msg.payload &&
      'token' in msg.payload &&
      'recipient' in msg.payload &&
      'validUntil' in msg.payload
    );
  }

  export function isPaymentProofMessage(message: unknown): message is Message & { payload: PaymentProof } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const msg = message as Record<string, unknown>;
    return (
      msg.type === 'submit-payment-proof' &&
      typeof msg.payload === 'object' &&
      msg.payload !== null &&
      'invoiceId' in msg.payload &&
      'txHash' in msg.payload &&
      'chainId' in msg.payload
    );
  }

  export function isPaymentVerifiedMessage(message: unknown): message is Message & { payload: { invoiceId: string } } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const msg = message as Record<string, unknown>;
    return (
      msg.type === 'payment-verified' &&
      typeof msg.payload === 'object' &&
      msg.payload !== null &&
      'invoiceId' in msg.payload
    );
  }

  export function isPaymentFailedMessage(message: unknown): message is Message & { payload: { invoiceId: string; reason: string } } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const msg = message as Record<string, unknown>;
    return (
      msg.type === 'payment-failed' &&
      typeof msg.payload === 'object' &&
      msg.payload !== null &&
      'invoiceId' in msg.payload &&
      'reason' in msg.payload
    );
  }

  export function createStreamingAgreement(
    jobId: string,
    payer: string,
    recipient: string,
    chainId: number,
    token: string,
    ratePerToken: string
  ): StreamingAgreement {
    return {
      id: nanoid(),
      jobId,
      payer,
      recipient,
      chainId,
      token,
      ratePerToken,
      accumulatedAmount: '0',
      lastTick: Date.now(),
      status: 'active',
      createdAt: Date.now(),
    };
  }

  export function recordStreamingTick(
    agreement: StreamingAgreement,
    tokensGenerated: number
  ): { agreement: StreamingAgreement; amountOwed: string } {
    const currentAmount = parseFloat(agreement.accumulatedAmount);
    const rate = parseFloat(agreement.ratePerToken);
    const newAmount = currentAmount + tokensGenerated * rate;
    const amountOwed = (newAmount - currentAmount).toString();

    return {
      agreement: {
        ...agreement,
        accumulatedAmount: newAmount.toString(),
        lastTick: Date.now(),
      },
      amountOwed,
    };
  }

  export function closeStreamingAgreement(agreement: StreamingAgreement): StreamingAgreement {
    return {
      ...agreement,
      status: 'closed',
      closedAt: Date.now(),
    };
  }

  export function createEscrowAgreement(
    jobId: string,
    payer: string,
    recipient: string,
    chainId: number,
    token: string,
    totalAmount: string,
    milestones: Array<{ amount: string }>,
    requiresApproval?: boolean,
    approver?: string
  ): EscrowAgreement {
    const escrowMilestones: EscrowMilestone[] = milestones.map((m) => ({
      id: nanoid(),
      amount: m.amount,
      released: false,
    }));

    return {
      id: nanoid(),
      jobId,
      payer,
      recipient,
      chainId,
      token,
      totalAmount,
      milestones: escrowMilestones,
      status: 'locked',
      createdAt: Date.now(),
      requiresApproval: requiresApproval ?? false,
      approver,
    };
  }

  export function releaseEscrowMilestone(
    agreement: EscrowAgreement,
    milestoneId: string,
    txHash?: string
  ): EscrowAgreement {
    const milestones = agreement.milestones.map((m) =>
      m.id === milestoneId
        ? {
            ...m,
            released: true,
            releasedAt: Date.now(),
            txHash,
          }
        : m
    );

    const releasedCount = milestones.filter((m) => m.released).length;
    const totalCount = milestones.length;

    let status: EscrowAgreement['status'] = 'locked';
    if (releasedCount === totalCount) {
      status = 'fully-released';
    } else if (releasedCount > 0) {
      status = 'partially-released';
    }

    return {
      ...agreement,
      milestones,
      status,
    };
  }

  export function createStakeRequirement(
    jobId: string,
    chainId: number,
    token: string,
    amount: string,
    slashingCondition: string,
    verifier?: string
  ): StakeRequirement {
    return {
      id: nanoid(),
      jobId,
      chainId,
      token,
      amount,
      slashingCondition,
      verifier,
    };
  }

  export function createStakePosition(
    stakeRequirementId: string,
    jobId: string,
    staker: string,
    chainId: number,
    token: string,
    amount: string,
    txHash?: string
  ): StakePosition {
    return {
      id: nanoid(),
      stakeRequirementId,
      jobId,
      staker,
      chainId,
      token,
      amount,
      status: 'locked',
      lockedAt: Date.now(),
      txHash,
    };
  }

  export function releaseStake(
    position: StakePosition,
    txHash?: string
  ): StakePosition {
    return {
      ...position,
      status: 'released',
      releasedAt: Date.now(),
      releaseTxHash: txHash,
    };
  }

  export function slashStake(
    position: StakePosition,
    txHash?: string
  ): StakePosition {
    return {
      ...position,
      status: 'slashed',
      slashedAt: Date.now(),
      slashTxHash: txHash,
    };
  }

  export function createSwarmSplit(
    jobId: string,
    payer: string,
    totalAmount: string,
    chainId: number,
    token: string,
    participants: Array<{ peerId: string; walletAddress: string; contribution: number }>
  ): SwarmSplit {
    const totalContribution = participants.reduce((sum, p) => sum + p.contribution, 0);
    const totalAmountNum = parseFloat(totalAmount);

    const swarmParticipants: SwarmParticipant[] = participants.map((p) => {
      const proportion = p.contribution / totalContribution;
      const amount = (totalAmountNum * proportion).toString();
      return {
        peerId: p.peerId,
        walletAddress: p.walletAddress,
        contribution: p.contribution,
        amount,
      };
    });

    return {
      id: nanoid(),
      jobId,
      payer,
      totalAmount,
      chainId,
      token,
      participants: swarmParticipants,
      status: 'pending',
      createdAt: Date.now(),
    };
  }

  export function distributeSwarmSplit(split: SwarmSplit): {
    split: SwarmSplit;
    invoices: Invoice[];
  } {
    const invoices: Invoice[] = split.participants.map((participant) =>
      createInvoice(
        split.jobId,
        split.chainId,
        participant.amount,
        split.token,
        participant.walletAddress,
        Date.now() + 3600000
      )
    );

    return {
      split: {
        ...split,
        status: 'distributed',
        distributedAt: Date.now(),
      },
      invoices,
    };
  }

  export function createPaymentLedgerEntry(
    type: PaymentLedgerEntry['type'],
    chainId: number,
    token: string,
    amount: string,
    recipient: string,
    payer: string,
    jobId?: string,
    metadata?: Record<string, unknown>
  ): PaymentLedgerEntry {
    return {
      id: nanoid(),
      type,
      status: type === 'streaming' ? 'streaming' : 'pending',
      chainId,
      token,
      amount,
      recipient,
      payer,
      jobId,
      createdAt: Date.now(),
      metadata,
    };
  }

  export function markLedgerEntrySettled(
    entry: PaymentLedgerEntry,
    txHash: string
  ): PaymentLedgerEntry {
    return {
      ...entry,
      status: 'settled',
      settledAt: Date.now(),
      txHash,
    };
  }

  export function markLedgerEntrySlashed(
    entry: PaymentLedgerEntry,
    txHash: string
  ): PaymentLedgerEntry {
    return {
      ...entry,
      status: 'slashed',
      settledAt: Date.now(),
      txHash,
    };
  }

  export function createSettlementIntent(
    type: SettlementIntent['type'],
    ledgerEntryId: string,
    invoice?: Invoice,
    priority?: number,
    maxRetries?: number
  ): SettlementIntent {
    return {
      id: nanoid(),
      type,
      ledgerEntryId,
      invoice,
      priority: priority ?? 0,
      createdAt: Date.now(),
      retryCount: 0,
      maxRetries: maxRetries ?? 3,
    };
  }

  export function incrementSettlementRetry(intent: SettlementIntent): SettlementIntent {
    return {
      ...intent,
      retryCount: intent.retryCount + 1,
    };
  }

  export function createStreamingTickMessage(
    from: string,
    to: string,
    channelId: string,
    tokensGenerated: number,
    amountOwed: string
  ): Message {
    return {
      id: nanoid(),
      from,
      to,
      type: 'streaming-tick',
      payload: {
        channelId,
        tokensGenerated,
        amountOwed,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    };
  }

  export function createEscrowApprovalMessage(
    from: string,
    to: string,
    agreementId: string,
    milestoneId: string,
    approved: boolean
  ): Message {
    return {
      id: nanoid(),
      from,
      to,
      type: 'escrow-approval',
      payload: {
        agreementId,
        milestoneId,
        approved,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    };
  }

  export function createStakeConfirmationMessage(
    from: string,
    to: string,
    positionId: string,
    txHash: string,
    status: 'locked' | 'released' | 'slashed'
  ): Message {
    return {
      id: nanoid(),
      from,
      to,
      type: 'stake-confirmation',
      payload: {
        positionId,
        txHash,
        status,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    };
  }

  export function createSwarmDistributionMessage(
    from: string,
    to: string,
    splitId: string,
    invoices: Invoice[]
  ): Message {
    return {
      id: nanoid(),
      from,
      to,
      type: 'swarm-distribution',
      payload: {
        splitId,
        invoices,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    };
  }

  export function isStreamingTickMessage(
    message: unknown
  ): message is Message & { payload: { channelId: string; tokensGenerated: number; amountOwed: string; timestamp: number } } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const msg = message as Record<string, unknown>;
    return (
      msg.type === 'streaming-tick' &&
      typeof msg.payload === 'object' &&
      msg.payload !== null &&
      'channelId' in msg.payload &&
      'tokensGenerated' in msg.payload &&
      'amountOwed' in msg.payload
    );
  }

  export function isEscrowApprovalMessage(
    message: unknown
  ): message is Message & { payload: { agreementId: string; milestoneId: string; approved: boolean; timestamp: number } } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const msg = message as Record<string, unknown>;
    return (
      msg.type === 'escrow-approval' &&
      typeof msg.payload === 'object' &&
      msg.payload !== null &&
      'agreementId' in msg.payload &&
      'milestoneId' in msg.payload &&
      'approved' in msg.payload
    );
  }

  export function isStakeConfirmationMessage(
    message: unknown
  ): message is Message & { payload: { positionId: string; txHash: string; status: 'locked' | 'released' | 'slashed'; timestamp: number } } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const msg = message as Record<string, unknown>;
    return (
      msg.type === 'stake-confirmation' &&
      typeof msg.payload === 'object' &&
      msg.payload !== null &&
      'positionId' in msg.payload &&
      'txHash' in msg.payload &&
      'status' in msg.payload
    );
  }

  export function isSwarmDistributionMessage(
    message: unknown
  ): message is Message & { payload: { splitId: string; invoices: Invoice[]; timestamp: number } } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const msg = message as Record<string, unknown>;
    return (
      msg.type === 'swarm-distribution' &&
      typeof msg.payload === 'object' &&
      msg.payload !== null &&
      'splitId' in msg.payload &&
      'invoices' in msg.payload &&
      Array.isArray((msg.payload as Record<string, unknown>).invoices)
    );
  }
}

