import { getContract, formatEther, keccak256, toHex } from 'viem';
import type { WalletState } from './wallet';
import { getPublicClient, getWalletClient } from './wallet';
import { WORK_REWARDS_ABI, getContractAddresses } from '@ecco/contracts';

export interface PeerStats {
  totalEarned: bigint;
  jobsCompleted: bigint;
  canWork: boolean;
}

export interface RewardEstimate {
  baseReward: bigint;
  finalReward: bigint;
  difficultyMultiplier: number;
  qualityMultiplier: number;
}

export interface BatchRewardInput {
  jobId: `0x${string}`;
  peer: `0x${string}`;
  difficulty: bigint;
  consensusAchieved: boolean;
  fastResponse: boolean;
}

function getWorkRewardsContract(state: WalletState, chainId: number) {
  const addresses = getContractAddresses(chainId);
  const publicClient = getPublicClient(state, chainId);

  return getContract({
    address: addresses.workRewards,
    abi: WORK_REWARDS_ABI,
    client: publicClient,
  });
}

export function generateJobId(jobData: string): `0x${string}` {
  return keccak256(toHex(jobData));
}

export async function distributeReward(
  state: WalletState,
  chainId: number,
  jobId: `0x${string}`,
  peer: `0x${string}`,
  difficulty: bigint,
  consensusAchieved: boolean,
  fastResponse: boolean
): Promise<`0x${string}`> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const hash = await walletClient.writeContract({
    address: addresses.workRewards,
    abi: WORK_REWARDS_ABI,
    functionName: 'distributeReward',
    args: [jobId, peer, difficulty, consensusAchieved, fastResponse],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export async function distributeBatchRewards(
  state: WalletState,
  chainId: number,
  inputs: BatchRewardInput[]
): Promise<`0x${string}`> {
  const addresses = getContractAddresses(chainId);
  const walletClient = getWalletClient(state, chainId);

  if (!walletClient.account) {
    throw new Error('Wallet client account not available');
  }

  const formattedInputs = inputs.map(input => ({
    jobId: input.jobId,
    peer: input.peer,
    difficulty: input.difficulty,
    consensusAchieved: input.consensusAchieved,
    fastResponse: input.fastResponse,
  }));

  const hash = await walletClient.writeContract({
    address: addresses.workRewards,
    abi: WORK_REWARDS_ABI,
    functionName: 'distributeBatchRewards',
    args: [formattedInputs],
    account: walletClient.account,
    chain: walletClient.chain,
  });

  return hash;
}

export async function estimateReward(
  state: WalletState,
  chainId: number,
  peer: `0x${string}`,
  difficulty: bigint,
  consensusAchieved: boolean,
  fastResponse: boolean
): Promise<bigint> {
  const contract = getWorkRewardsContract(state, chainId);
  return await contract.read.estimateReward([peer, difficulty, consensusAchieved, fastResponse]);
}

export async function getPeerStats(
  state: WalletState,
  chainId: number,
  peer: `0x${string}`
): Promise<PeerStats> {
  const contract = getWorkRewardsContract(state, chainId);
  const [totalEarned, jobsCompleted, canWork] = await contract.read.getPeerStats([peer]);

  return {
    totalEarned,
    jobsCompleted,
    canWork,
  };
}

export async function isJobRewarded(
  state: WalletState,
  chainId: number,
  jobId: `0x${string}`
): Promise<boolean> {
  const contract = getWorkRewardsContract(state, chainId);
  return await contract.read.rewardedJobs([jobId]);
}

export async function getRewardsPoolBalance(
  state: WalletState,
  chainId: number
): Promise<bigint> {
  const contract = getWorkRewardsContract(state, chainId);
  return await contract.read.getRewardsPoolBalance();
}

export async function getTotalRewardsDistributed(
  state: WalletState,
  chainId: number
): Promise<bigint> {
  const contract = getWorkRewardsContract(state, chainId);
  return await contract.read.totalRewardsDistributed();
}

export async function getTotalJobsRewarded(
  state: WalletState,
  chainId: number
): Promise<bigint> {
  const contract = getWorkRewardsContract(state, chainId);
  return await contract.read.totalJobsRewarded();
}

export async function getRewardParameters(
  state: WalletState,
  chainId: number
): Promise<{
  baseRewardPerJob: bigint;
  consensusBonus: bigint;
  fastResponseBonus: bigint;
  stakerBonus: bigint;
}> {
  const contract = getWorkRewardsContract(state, chainId);

  const [baseRewardPerJob, consensusBonus, fastResponseBonus, stakerBonus] = await Promise.all([
    contract.read.baseRewardPerJob(),
    contract.read.consensusBonus(),
    contract.read.fastResponseBonus(),
    contract.read.stakerBonus(),
  ]);

  return {
    baseRewardPerJob,
    consensusBonus,
    fastResponseBonus,
    stakerBonus,
  };
}

export function formatEccoReward(amount: bigint): string {
  return formatEther(amount);
}
