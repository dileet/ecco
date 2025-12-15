import { getContract, keccak256, toHex } from 'viem';
import type { WalletState } from './wallet';
import { getPublicClient, getWalletClient } from './wallet';
import { REPUTATION_REGISTRY_ABI, FEE_COLLECTOR_ABI, getContractAddresses } from '@ecco/contracts';
import { approveEcco, getEccoAllowance } from './token';

export interface PeerReputation {
  score: bigint;
  rawPositive: bigint;
  rawNegative: bigint;
  totalJobs: bigint;
  stake: bigint;
  lastActive: bigint;
  unstakeRequestTime: bigint;
  unstakeAmount: bigint;
}

export interface StakeInfo {
  stake: bigint;
  canWork: boolean;
  effectiveScore: bigint;
}

export interface PendingRewards {
  pending: bigint;
}

function getReputationContract(state: WalletState, chainId: number) {
  const addresses = getContractAddresses(chainId);
  const publicClient = getPublicClient(state, chainId);

  return getContract({
    address: addresses.reputationRegistry,
    abi: REPUTATION_REGISTRY_ABI,
    client: publicClient,
  });
}

function getFeeCollectorContract(state: WalletState, chainId: number) {
  const addresses = getContractAddresses(chainId);
  const publicClient = getPublicClient(state, chainId);

  return getContract({
    address: addresses.feeCollector,
    abi: FEE_COLLECTOR_ABI,
    client: publicClient,
  });
}

export async function stake(state: WalletState, chainId: number, amount: bigint): Promise<`0x${string}`> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const allowance = await getEccoAllowance(state, chainId, addresses.reputationRegistry, amount);
  if (!allowance.isApproved) {
    await approveEcco(state, chainId, addresses.reputationRegistry, amount);
  }

  const hash = await walletClient.writeContract({
    address: addresses.reputationRegistry,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'stake',
    args: [amount],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export async function requestUnstake(
  state: WalletState,
  chainId: number,
  amount: bigint
): Promise<`0x${string}`> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const hash = await walletClient.writeContract({
    address: addresses.reputationRegistry,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'requestUnstake',
    args: [amount],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export async function completeUnstake(state: WalletState, chainId: number): Promise<`0x${string}`> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const hash = await walletClient.writeContract({
    address: addresses.reputationRegistry,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'completeUnstake',
    args: [],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export function generatePaymentId(txHash: string, payer: string, payee: string, timestamp: number): `0x${string}` {
  const data = `${txHash}:${payer}:${payee}:${timestamp}`;
  return keccak256(toHex(data));
}

export async function recordPayment(
  state: WalletState,
  chainId: number,
  paymentId: `0x${string}`,
  payee: `0x${string}`,
  amount: bigint
): Promise<`0x${string}`> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const hash = await walletClient.writeContract({
    address: addresses.reputationRegistry,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'recordPayment',
    args: [paymentId, payee, amount],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export async function rateAfterPayment(
  state: WalletState,
  chainId: number,
  paymentId: `0x${string}`,
  delta: number
): Promise<`0x${string}`> {
  if (delta < -5 || delta > 5) {
    throw new Error('Rating delta must be between -5 and 5');
  }

  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const hash = await walletClient.writeContract({
    address: addresses.reputationRegistry,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'rateAfterPayment',
    args: [paymentId, delta],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export async function batchRate(
  state: WalletState,
  chainId: number,
  ratings: Array<{ paymentId: `0x${string}`; delta: number }>
): Promise<`0x${string}`> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const paymentIds = ratings.map((r) => r.paymentId);
  const deltas = ratings.map((r) => {
    if (r.delta < -5 || r.delta > 5) {
      throw new Error('Rating delta must be between -5 and 5');
    }
    return r.delta;
  });

  const hash = await walletClient.writeContract({
    address: addresses.reputationRegistry,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'batchRate',
    args: [paymentIds, deltas],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export async function canWork(state: WalletState, chainId: number, peer: `0x${string}`): Promise<boolean> {
  const contract = getReputationContract(state, chainId);
  return await contract.read.canWork([peer]);
}

export async function canRate(state: WalletState, chainId: number, rater: `0x${string}`): Promise<boolean> {
  const contract = getReputationContract(state, chainId);
  return await contract.read.canRate([rater]);
}

export async function getEffectiveScore(state: WalletState, chainId: number, peer: `0x${string}`): Promise<bigint> {
  const contract = getReputationContract(state, chainId);
  return await contract.read.getEffectiveScore([peer]);
}

export async function getStakeInfo(state: WalletState, chainId: number, peer: `0x${string}`): Promise<StakeInfo> {
  const contract = getReputationContract(state, chainId);
  const [stakeAmount, canWorkStatus, effectiveScore] = await contract.read.getStakeInfo([peer]);

  return {
    stake: stakeAmount,
    canWork: canWorkStatus,
    effectiveScore,
  };
}

export async function getReputation(state: WalletState, chainId: number, peer: `0x${string}`): Promise<PeerReputation> {
  const contract = getReputationContract(state, chainId);
  const result = await contract.read.getReputation([peer]);

  return {
    score: result.score,
    rawPositive: result.rawPositive,
    rawNegative: result.rawNegative,
    totalJobs: result.totalJobs,
    stake: result.stake,
    lastActive: result.lastActive,
    unstakeRequestTime: result.unstakeRequestTime,
    unstakeAmount: result.unstakeAmount,
  };
}

export async function getRatingWeight(
  state: WalletState,
  chainId: number,
  rater: `0x${string}`,
  paymentAmount: bigint
): Promise<bigint> {
  const contract = getReputationContract(state, chainId);
  return await contract.read.getRatingWeight([rater, paymentAmount]);
}

export async function getTotalStaked(state: WalletState, chainId: number): Promise<bigint> {
  const contract = getReputationContract(state, chainId);
  return await contract.read.totalStaked();
}

export async function getMinStakes(
  state: WalletState,
  chainId: number
): Promise<{ toWork: bigint; toRate: bigint }> {
  const contract = getReputationContract(state, chainId);
  const [toWork, toRate] = await Promise.all([
    contract.read.minStakeToWork(),
    contract.read.minStakeToRate(),
  ]);

  return { toWork, toRate };
}

export async function calculateFee(
  state: WalletState,
  chainId: number,
  amount: bigint
): Promise<bigint> {
  const contract = getFeeCollectorContract(state, chainId);
  return await contract.read.calculateFee([amount]);
}

export async function getPendingRewards(state: WalletState, chainId: number, staker: `0x${string}`): Promise<bigint> {
  const contract = getFeeCollectorContract(state, chainId);
  return await contract.read.pendingRewards([staker]);
}

export async function claimRewards(state: WalletState, chainId: number): Promise<`0x${string}`> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const hash = await walletClient.writeContract({
    address: addresses.feeCollector,
    abi: FEE_COLLECTOR_ABI,
    functionName: 'claimRewards',
    args: [],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export async function distributeFees(state: WalletState, chainId: number): Promise<`0x${string}`> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const hash = await walletClient.writeContract({
    address: addresses.feeCollector,
    abi: FEE_COLLECTOR_ABI,
    functionName: 'distributeFees',
    args: [],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}
