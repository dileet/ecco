import type {
  Invoice,
  StreamingAgreement,
  EscrowAgreement,
  SwarmSplit,
  SwarmParticipant,
} from '../types';
import { nanoid } from 'nanoid';

const PRECISION_DECIMALS = 18;
const PRECISION_MULTIPLIER = 10n ** BigInt(PRECISION_DECIMALS);

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
  if (Date.now() > invoice.validUntil) {
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
  const increment = (tokensBigInt * rate) / PRECISION_MULTIPLIER;
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

export function createSwarmSplit(
  jobId: string,
  payer: string,
  totalAmount: string,
  chainId: number,
  token: string,
  participants: Array<{ peerId: string; walletAddress: string; contribution: number }>
): SwarmSplit {
  const totalContribution = participants.reduce((sum, p) => sum + p.contribution, 0);
  const totalAmountBigInt = parseDecimalToBigInt(totalAmount);

  const swarmParticipants: SwarmParticipant[] = participants.map((p) => {
    const contributionBigInt = BigInt(Math.round(p.contribution * 1e9));
    const totalContributionBigInt = BigInt(Math.round(totalContribution * 1e9));
    const amount = (totalAmountBigInt * contributionBigInt) / totalContributionBigInt;
    return {
      peerId: p.peerId,
      walletAddress: p.walletAddress,
      contribution: p.contribution,
      amount: bigIntToDecimalString(amount),
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
  const invoices: Invoice[] = split.participants.map((participant) => ({
    id: nanoid(),
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
