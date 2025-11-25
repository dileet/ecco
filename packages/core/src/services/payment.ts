import type {
  Invoice,
  StreamingAgreement,
  EscrowAgreement,
  SwarmSplit,
  SwarmParticipant,
} from '../types';
import { nanoid } from 'nanoid';

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
