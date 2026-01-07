import Decimal from 'decimal.js';
import type {
  Invoice,
  StreamingAgreement,
  EscrowAgreement,
  SwarmSplit,
  SwarmParticipant,
} from '../types';

const PRECISION_DECIMALS = 18;
const MAX_SAFE_CONTRIBUTION = Number.MAX_SAFE_INTEGER / 1e9;
const INVOICE_EXPIRATION_GRACE_MS = 60000;

function parseDecimalToBigInt(value: string): bigint {
  const [integerPart, fractionalPart = ''] = value.split('.');
  const paddedFractional = fractionalPart
    .slice(0, PRECISION_DECIMALS)
    .padEnd(PRECISION_DECIMALS, '0');
  const combined = integerPart + paddedFractional;
  return BigInt(combined);
}

function bigIntToDecimalString(value: bigint): string {
  const isNegative = value < 0n;
  const absoluteValue = isNegative ? -value : value;
  const str = absoluteValue.toString().padStart(PRECISION_DECIMALS + 1, '0');
  const integerPart = str.slice(0, -PRECISION_DECIMALS) || '0';
  const fractionalPart = str.slice(-PRECISION_DECIMALS).replace(/0+$/, '');
  const result = fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;
  return isNegative ? `-${result}` : result;
}

export function validateInvoice(invoice: Invoice): boolean {
  if (Date.now() > invoice.validUntil + INVOICE_EXPIRATION_GRACE_MS) {
    throw new Error('Invoice has expired');
  }
  return true;
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
  milestoneId: string,
  txHash?: string
): EscrowAgreement {
  const existingMilestone = agreement.milestones.find((m) => m.id === milestoneId);
  if (!existingMilestone) {
    throw new Error(`Milestone ${milestoneId} not found in agreement ${agreement.id}`);
  }
  if (existingMilestone.released) {
    throw new Error(`Milestone ${milestoneId} has already been released`);
  }

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

function safeContributionToBigInt(contribution: number): bigint {
  if (contribution < 0) {
    throw new Error('Contribution cannot be negative');
  }
  if (contribution > MAX_SAFE_CONTRIBUTION) {
    throw new Error(`Contribution ${contribution} exceeds maximum safe value ${MAX_SAFE_CONTRIBUTION}`);
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
    recipient: participant.walletAddress,
    validUntil: Date.now() + 3600000,
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
