import { getContract, formatEther, parseEther, keccak256, toHex } from 'viem';
import type { WalletState } from './wallet';
import { getPublicClient, getWalletClient } from './wallet';
import { REPUTATION_REGISTRY_ABI, FEE_COLLECTOR_ABI, getContractAddresses } from '@ecco/contracts';
import { approveEcco, getEccoAllowance } from './token';

export interface PeerReputation {
  score: bigint;
  rawPositive: bigint;
  rawNegative: bigint;
  totalJobs: bigint;
  ethStake: bigint;
  eccoStake: bigint;
  lastActive: bigint;
  unstakeRequestTime: bigint;
  unstakeEthAmount: bigint;
  unstakeEccoAmount: bigint;
}

export interface StakeInfo {
  ethStake: bigint;
  eccoStake: bigint;
  isEccoStaker: boolean;
  effectiveScore: bigint;
}

export interface FeeInfo {
  feePercent: bigint;
  feeAmount: bigint;
  isEccoDiscount: boolean;
}

export interface PendingRewards {
  ethPending: bigint;
  eccoPending: bigint;
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

export async function stakeEth(state: WalletState, chainId: number, amount: bigint): Promise<`0x${string}`> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const hash = await walletClient.writeContract({
    address: addresses.reputationRegistry,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'stakeEth',
    args: [],
    value: amount,
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export async function stakeEcco(state: WalletState, chainId: number, amount: bigint): Promise<`0x${string}`> {
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
    functionName: 'stakeEcco',
    args: [amount],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export async function requestUnstake(
  state: WalletState,
  chainId: number,
  ethAmount: bigint,
  eccoAmount: bigint
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
    args: [ethAmount, eccoAmount],
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

export async function isEccoStaker(state: WalletState, chainId: number, peer: `0x${string}`): Promise<boolean> {
  const contract = getReputationContract(state, chainId);
  return await contract.read.isEccoStaker([peer]);
}

export async function getEffectiveScore(state: WalletState, chainId: number, peer: `0x${string}`): Promise<bigint> {
  const contract = getReputationContract(state, chainId);
  return await contract.read.getEffectiveScore([peer]);
}

export async function getSelectionScore(state: WalletState, chainId: number, peer: `0x${string}`): Promise<bigint> {
  const contract = getReputationContract(state, chainId);
  return await contract.read.getSelectionScore([peer]);
}

export async function getStakeInfo(state: WalletState, chainId: number, peer: `0x${string}`): Promise<StakeInfo> {
  const contract = getReputationContract(state, chainId);
  const [ethStake, eccoStake, _isEccoStaker, effectiveScore] = await contract.read.getStakeInfo([peer]);

  return {
    ethStake,
    eccoStake,
    isEccoStaker: _isEccoStaker,
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
    ethStake: result.ethStake,
    eccoStake: result.eccoStake,
    lastActive: result.lastActive,
    unstakeRequestTime: result.unstakeRequestTime,
    unstakeEthAmount: result.unstakeEthAmount,
    unstakeEccoAmount: result.unstakeEccoAmount,
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

export async function getTotalStaked(
  state: WalletState,
  chainId: number
): Promise<{ eth: bigint; ecco: bigint }> {
  const contract = getReputationContract(state, chainId);
  const [eth, ecco] = await Promise.all([
    contract.read.totalStakedEth(),
    contract.read.totalStakedEcco(),
  ]);

  return { eth, ecco };
}

export async function getMinStakes(
  state: WalletState,
  chainId: number
): Promise<{ ethToWork: bigint; eccoToWork: bigint }> {
  const contract = getReputationContract(state, chainId);
  const [ethToWork, eccoToWork] = await Promise.all([
    contract.read.minEthStakeToWork(),
    contract.read.minEccoStakeToWork(),
  ]);

  return { ethToWork, eccoToWork };
}

export async function calculateFee(
  state: WalletState,
  chainId: number,
  payer: `0x${string}`,
  amount: bigint
): Promise<FeeInfo> {
  const contract = getFeeCollectorContract(state, chainId);
  const [feePercent, feeAmount, isEccoDiscount] = await contract.read.calculateFee([payer, amount]);

  return {
    feePercent,
    feeAmount,
    isEccoDiscount,
  };
}

export async function getPendingRewards(state: WalletState, chainId: number, staker: `0x${string}`): Promise<PendingRewards> {
  const contract = getFeeCollectorContract(state, chainId);
  const [ethPending, eccoPending] = await contract.read.pendingRewards([staker]);

  return { ethPending, eccoPending };
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
