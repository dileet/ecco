import type { PublicClient, WalletClient } from 'viem';
import { zeroAddress } from 'viem';
import type { ReputationRegistryState, FeedbackSummary } from './types';

const AGENT_REPUTATION_REGISTRY_ABI = [
  {
    name: 'giveFeedback',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'revokeFeedback',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    name: 'appendResponse',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
      { name: 'responseURI', type: 'string' },
      { name: 'responseHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'getSummary',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
  },
  {
    name: 'readFeedback',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'isRevoked', type: 'bool' },
    ],
  },
  {
    name: 'readAllFeedback',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'includeRevoked', type: 'bool' },
    ],
    outputs: [
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'feedbackIndexes', type: 'uint64[]' },
      { name: 'values', type: 'int128[]' },
      { name: 'valueDecimalsArr', type: 'uint8[]' },
      { name: 'tag1s', type: 'string[]' },
      { name: 'tag2s', type: 'string[]' },
      { name: 'revokedStatuses', type: 'bool[]' },
    ],
  },
  {
    name: 'getClients',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    name: 'getLastIndex',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    name: 'getResponseCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
      { name: 'responders', type: 'address[]' },
    ],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    name: 'getIdentityRegistry',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export function createReputationRegistryState(
  chainId: number,
  registryAddress: `0x${string}`,
  identityRegistryAddress: `0x${string}`
): ReputationRegistryState {
  return {
    chainId,
    registryAddress,
    identityRegistryAddress,
  };
}

export async function giveFeedback(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: ReputationRegistryState,
  agentId: bigint,
  value: bigint,
  valueDecimals: number,
  tag1: string,
  tag2: string,
  endpoint: string,
  feedbackURI: string,
  feedbackHash: `0x${string}`
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  if (valueDecimals < 0 || valueDecimals > 18) {
    throw new Error('valueDecimals must be between 0 and 18');
  }

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'giveFeedback',
    args: [agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash],
    account,
  });

  return walletClient.writeContract(request);
}

export async function revokeFeedback(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: ReputationRegistryState,
  agentId: bigint,
  feedbackIndex: bigint
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'revokeFeedback',
    args: [agentId, feedbackIndex],
    account,
  });

  return walletClient.writeContract(request);
}

export async function appendResponse(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: ReputationRegistryState,
  agentId: bigint,
  clientAddress: `0x${string}`,
  feedbackIndex: bigint,
  responseURI: string,
  responseHash: `0x${string}`
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'appendResponse',
    args: [agentId, clientAddress, feedbackIndex, responseURI, responseHash],
    account,
  });

  return walletClient.writeContract(request);
}

export async function getSummary(
  publicClient: PublicClient,
  state: ReputationRegistryState,
  agentId: bigint,
  clientAddresses: `0x${string}`[],
  tag1: string = '',
  tag2: string = ''
): Promise<FeedbackSummary> {
  if (clientAddresses.length === 0) {
    throw new Error('clientAddresses MUST be provided (non-empty) per ERC-8004 spec');
  }

  const [count, summaryValue, summaryValueDecimals] = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'getSummary',
    args: [agentId, clientAddresses, tag1, tag2],
  });

  return {
    count: Number(count),
    summaryValue,
    summaryValueDecimals,
  };
}

export async function readFeedback(
  publicClient: PublicClient,
  state: ReputationRegistryState,
  agentId: bigint,
  clientAddress: `0x${string}`,
  feedbackIndex: bigint
): Promise<{ value: bigint; valueDecimals: number; tag1: string; tag2: string; isRevoked: boolean }> {
  const [value, valueDecimals, tag1, tag2, isRevoked] = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'readFeedback',
    args: [agentId, clientAddress, feedbackIndex],
  });

  return {
    value,
    valueDecimals,
    tag1,
    tag2,
    isRevoked,
  };
}

export async function readAllFeedback(
  publicClient: PublicClient,
  state: ReputationRegistryState,
  agentId: bigint,
  clientAddresses: `0x${string}`[] = [],
  tag1: string = '',
  tag2: string = '',
  includeRevoked: boolean = false
): Promise<{
  clientAddresses: `0x${string}`[];
  feedbackIndexes: bigint[];
  values: bigint[];
  valueDecimalsArr: number[];
  tag1s: string[];
  tag2s: string[];
  revokedStatuses: boolean[];
}> {
  const [addresses, indexes, values, valueDecimalsArr, tag1s, tag2s, revokedStatuses] = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'readAllFeedback',
    args: [agentId, clientAddresses, tag1, tag2, includeRevoked],
  });

  return {
    clientAddresses: [...addresses],
    feedbackIndexes: indexes.map((idx) => BigInt(idx)),
    values: [...values],
    valueDecimalsArr: [...valueDecimalsArr],
    tag1s: [...tag1s],
    tag2s: [...tag2s],
    revokedStatuses: [...revokedStatuses],
  };
}

export async function getClients(
  publicClient: PublicClient,
  state: ReputationRegistryState,
  agentId: bigint
): Promise<`0x${string}`[]> {
  const result = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'getClients',
    args: [agentId],
  });
  return [...result];
}

export async function getLastIndex(
  publicClient: PublicClient,
  state: ReputationRegistryState,
  agentId: bigint,
  clientAddress: `0x${string}`
): Promise<bigint> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'getLastIndex',
    args: [agentId, clientAddress],
  });
}

export async function getResponseCount(
  publicClient: PublicClient,
  state: ReputationRegistryState,
  agentId: bigint,
  clientAddress?: `0x${string}`,
  feedbackIndex: bigint = 0n,
  responders: `0x${string}`[] = []
): Promise<bigint> {
  const resolvedClient = clientAddress ?? zeroAddress;
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'getResponseCount',
    args: [agentId, resolvedClient, feedbackIndex, responders],
  });
}

export async function getReputationIdentityRegistry(
  publicClient: PublicClient,
  state: ReputationRegistryState
): Promise<`0x${string}`> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'getIdentityRegistry',
  });
}
