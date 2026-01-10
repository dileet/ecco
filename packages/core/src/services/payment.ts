import Decimal from 'decimal.js';
import { z } from 'zod';
import type {
  Invoice,
  StreamingAgreement,
  EscrowAgreement,
  SwarmSplit,
  SwarmParticipant,
} from '../types';
import { PAYMENT } from './constants';

const DecimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/, 'Invalid decimal format');

const VALID_ESCROW_TRANSITIONS: Record<EscrowAgreement['status'], EscrowAgreement['status'][]> = {
  'pending': ['locked', 'cancelled'],
  'locked': ['partially-released', 'fully-released', 'cancelled'],
  'partially-released': ['fully-released', 'cancelled'],
  'fully-released': [],
  'cancelled': [],
};

function parseDecimalToBigInt(value: string): bigint {
  const result = DecimalStringSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid decimal format: ${value}`);
  }
  const [integerPart, fractionalPart = ''] = value.split('.');
  if (integerPart.length > 60) {
    throw new Error(`Decimal value too large: ${value}`);
  }
  const paddedFractional = fractionalPart
    .slice(0, PAYMENT.PRECISION_DECIMALS)
    .padEnd(PAYMENT.PRECISION_DECIMALS, '0');
  const combined = integerPart + paddedFractional;
  return BigInt(combined);
}

function validateStatusTransition(
  current: EscrowAgreement['status'],
  next: EscrowAgreement['status']
): void {
  const allowed = VALID_ESCROW_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new Error(`Invalid status transition from ${current} to ${next}`);
  }
}

function bigIntToDecimalString(value: bigint): string {
  const isNegative = value < 0n;
  const absoluteValue = isNegative ? -value : value;
  const str = absoluteValue.toString().padStart(PAYMENT.PRECISION_DECIMALS + 1, '0');
  const integerPart = str.slice(0, -PAYMENT.PRECISION_DECIMALS) || '0';
  const fractionalPart = str.slice(-PAYMENT.PRECISION_DECIMALS).replace(/0+$/, '');
  const result = fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;
  return isNegative ? `-${result}` : result;
}

export function validateInvoice(invoice: Invoice, clockTolerance = PAYMENT.INVOICE_EXPIRATION_GRACE_MS): boolean {
  const now = Date.now();
  const expirationWithGrace = invoice.validUntil + clockTolerance;
  if (now > expirationWithGrace) {
    throw new Error(`Invoice has expired (expired at ${new Date(invoice.validUntil).toISOString()}, current time ${new Date(now).toISOString()}, grace period ${clockTolerance}ms)`);
  }
  return true;
}

export function resetStreamingAccumulated(agreement: StreamingAgreement): StreamingAgreement {
  return {
    ...agreement,
    accumulatedAmount: '0',
    lastTick: Date.now(),
  };
}

export function recordStreamingTick(
  agreement: StreamingAgreement,
  tokensGenerated: number
): { agreement: StreamingAgreement; amountOwed: string } {
  const currentAmount = parseDecimalToBigInt(agreement.accumulatedAmount);
  const rate = parseDecimalToBigInt(agreement.ratePerToken);
  const tokensBigInt = BigInt(tokensGenerated);
  const increment = tokensBigInt * rate;
  const newAmount = currentAmount + increment;
  const amountOwed = bigIntToDecimalString(increment);

  return {
    agreement: {
      ...agreement,
      accumulatedAmount: bigIntToDecimalString(newAmount),
      lastTick: Date.now(),
    },
    amountOwed,
  };
}

export function releaseEscrowMilestone(
  agreement: EscrowAgreement,
  milestoneId: string
): EscrowAgreement {
  if (agreement.status === 'cancelled') {
    throw new Error(`Cannot release milestone: agreement ${agreement.id} is cancelled`);
  }
  if (agreement.status === 'fully-released') {
    throw new Error(`Cannot release milestone: agreement ${agreement.id} is fully released`);
  }

  const existingMilestone = agreement.milestones.find((m) => m.id === milestoneId);
  if (!existingMilestone) {
    throw new Error(`Milestone ${milestoneId} not found in agreement ${agreement.id}`);
  }
  if (existingMilestone.released) {
    throw new Error(`Milestone ${milestoneId} has already been released`);
  }
  if (existingMilestone.status === 'cancelled') {
    throw new Error(`Milestone ${milestoneId} has been cancelled`);
  }

  const milestones = agreement.milestones.map((m) =>
    m.id === milestoneId
      ? {
          ...m,
          released: true,
          releasedAt: Date.now(),
          status: 'released' as const,
        }
      : m
  );

  const activeMilestones = milestones.filter((m) => m.status !== 'cancelled');
  const releasedCount = activeMilestones.filter((m) => m.released).length;
  const totalActiveCount = activeMilestones.length;

  let newStatus: EscrowAgreement['status'];
  if (totalActiveCount === 0) {
    newStatus = 'cancelled';
  } else if (releasedCount === totalActiveCount) {
    newStatus = 'fully-released';
  } else if (releasedCount > 0) {
    newStatus = 'partially-released';
  } else {
    newStatus = 'locked';
  }

  validateStatusTransition(agreement.status, newStatus);

  return {
    ...agreement,
    milestones,
    status: newStatus,
  };
}

function safeContributionToBigInt(contribution: number): bigint {
  if (contribution < 0) {
    throw new Error('Contribution cannot be negative');
  }
  if (contribution > PAYMENT.MAX_SAFE_CONTRIBUTION) {
    throw new Error(`Contribution ${contribution} exceeds maximum safe value ${PAYMENT.MAX_SAFE_CONTRIBUTION}`);
  }
  if (!Number.isFinite(contribution)) {
    throw new Error('Contribution must be a finite number');
  }
  const decimal = new Decimal(contribution).times(1e9).floor();
  return BigInt(decimal.toFixed(0));
}

export function createSwarmSplit(
  jobId: string,
  payer: string,
  totalAmount: string,
  chainId: number,
  token: string,
  participants: Array<{ peerId: string; walletAddress: string; contribution: number }>
): SwarmSplit {
  if (participants.length === 0) {
    throw new Error('At least one participant is required');
  }

  const totalAmountBigInt = parseDecimalToBigInt(totalAmount);

  let totalContributionBigInt = 0n;
  const contributionsBigInt: bigint[] = [];

  for (const p of participants) {
    const contrib = safeContributionToBigInt(p.contribution);
    contributionsBigInt.push(contrib);
    totalContributionBigInt += contrib;
  }

  if (totalContributionBigInt === 0n) {
    throw new Error('Total contribution cannot be zero');
  }

  const swarmParticipants: SwarmParticipant[] = participants.map((p, i) => {
    const contributionBigInt = contributionsBigInt[i];
    const amount = (totalAmountBigInt * contributionBigInt) / totalContributionBigInt;
    return {
      peerId: p.peerId,
      walletAddress: p.walletAddress,
      contribution: p.contribution,
      amount: bigIntToDecimalString(amount),
    };
  });

  return {
    id: crypto.randomUUID(),
    jobId,
    payer,
    totalAmount,
    chainId,
    token,
    participants: swarmParticipants,
    status: 'pending',
    createdAt: Date.now(),
    distributedAt: null,
  };
}

export function distributeSwarmSplit(split: SwarmSplit): {
  split: SwarmSplit;
  invoices: Invoice[];
} {
  const invoices: Invoice[] = split.participants.map((participant) => ({
    id: crypto.randomUUID(),
    jobId: split.jobId,
    chainId: split.chainId,
    amount: participant.amount,
    token: split.token,
    tokenAddress: null,
    recipient: participant.walletAddress,
    validUntil: Date.now() + 3600000,
    signature: null,
    publicKey: null,
  }));

  return {
    split: {
      ...split,
      status: 'distributed',
      distributedAt: Date.now(),
    },
    invoices,
  };
}

export interface AggregatedInvoice {
  recipient: string;
  chainId: number;
  token: string;
  totalAmount: string;
  invoiceIds: string[];
  jobIds: string[];
}

export function aggregateInvoices(invoices: Invoice[]): AggregatedInvoice[] {
  const groups = new Map<string, { invoices: Invoice[]; totalAmount: bigint }>();

  for (const invoice of invoices) {
    const key = `${invoice.recipient}:${invoice.chainId}:${invoice.token}`;
    const existing = groups.get(key);
    const amount = parseDecimalToBigInt(invoice.amount);

    if (existing) {
      existing.invoices.push(invoice);
      existing.totalAmount = existing.totalAmount + amount;
    } else {
      groups.set(key, { invoices: [invoice], totalAmount: amount });
    }
  }

  const result: AggregatedInvoice[] = [];
  for (const [, group] of groups) {
    const first = group.invoices[0];
    result.push({
      recipient: first.recipient,
      chainId: first.chainId,
      token: first.token,
      totalAmount: bigIntToDecimalString(group.totalAmount),
      invoiceIds: group.invoices.map((i) => i.id),
      jobIds: [...new Set(group.invoices.map((i) => i.jobId))],
    });
  }

  return result;
}
