import type { PublicClient, WalletClient } from 'viem';
import type { StakeRegistryState, AgentStake, StakeInfo } from './types';

const AGENT_STAKE_REGISTRY_ABI = [
  {
    name: 'stake',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'requestUnstake',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'completeUnstake',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'agentStakes',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [
      { name: 'stake', type: 'uint256' },
      { name: 'lastActive', type: 'uint256' },
      { name: 'unstakeRequestTime', type: 'uint256' },
      { name: 'unstakeAmount', type: 'uint256' },
    ],
  },
  {
    name: 'canWork',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'canWorkAgent',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'totalStaked',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'minStakeToWork',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export function createStakeRegistryState(
  chainId: number,
  registryAddress: `0x${string}`,
  identityRegistryAddress: `0x${string}`
): StakeRegistryState {
  return {
    chainId,
    registryAddress,
    identityRegistryAddress,
  };
}

export async function getAgentStake(
  publicClient: PublicClient,
  state: StakeRegistryState,
  agentId: bigint
): Promise<AgentStake> {
  const [stake, lastActive, unstakeRequestTime, unstakeAmount] = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_STAKE_REGISTRY_ABI,
    functionName: 'agentStakes',
    args: [agentId],
  });

  return {
    stake,
    lastActive,
    unstakeRequestTime,
    unstakeAmount,
  };
}

export async function canWork(
  publicClient: PublicClient,
  state: StakeRegistryState,
  wallet: `0x${string}`
): Promise<boolean> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_STAKE_REGISTRY_ABI,
    functionName: 'canWork',
    args: [wallet],
  });
}

export async function canWorkAgent(
  publicClient: PublicClient,
  state: StakeRegistryState,
  agentId: bigint
): Promise<boolean> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_STAKE_REGISTRY_ABI,
    functionName: 'canWorkAgent',
    args: [agentId],
  });
}

export async function fetchStakeInfo(
  publicClient: PublicClient,
  state: StakeRegistryState,
  agentId: bigint
): Promise<StakeInfo> {
  const [agentStake, canWorkResult] = await Promise.all([
    getAgentStake(publicClient, state, agentId),
    canWorkAgent(publicClient, state, agentId),
  ]);

  const effectiveScore = agentStake.stake > 0n ? agentStake.stake : 0n;

  return {
    stake: agentStake.stake,
    canWork: canWorkResult,
    effectiveScore,
    agentId,
  };
}

export async function getMinStakeToWork(
  publicClient: PublicClient,
  state: StakeRegistryState
): Promise<bigint> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_STAKE_REGISTRY_ABI,
    functionName: 'minStakeToWork',
  });
}

export async function getTotalStaked(
  publicClient: PublicClient,
  state: StakeRegistryState
): Promise<bigint> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_STAKE_REGISTRY_ABI,
    functionName: 'totalStaked',
  });
}

export async function stakeForAgent(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: StakeRegistryState,
  agentId: bigint,
  amount: bigint
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_STAKE_REGISTRY_ABI,
    functionName: 'stake',
    args: [agentId, amount],
    account,
  });

  return walletClient.writeContract(request);
}

export async function requestUnstake(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: StakeRegistryState,
  agentId: bigint,
  amount: bigint
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_STAKE_REGISTRY_ABI,
    functionName: 'requestUnstake',
    args: [agentId, amount],
    account,
  });

  return walletClient.writeContract(request);
}

export async function completeUnstake(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: StakeRegistryState,
  agentId: bigint
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_STAKE_REGISTRY_ABI,
    functionName: 'completeUnstake',
    args: [agentId],
    account,
  });

  return walletClient.writeContract(request);
}
