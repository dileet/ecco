import type { PublicClient, WalletClient } from 'viem';
import { keccak256, toBytes, stringToBytes } from 'viem';
import type { ReputationRegistryState, Feedback, FeedbackSummary } from './types';

const AGENT_REPUTATION_REGISTRY_ABI = [
  {
    name: 'giveFeedback',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'score', type: 'uint8' },
      { name: 'tag1', type: 'bytes32' },
      { name: 'tag2', type: 'bytes32' },
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
      { name: 'tag1', type: 'bytes32' },
      { name: 'tag2', type: 'bytes32' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'averageScore', type: 'uint8' },
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
      { name: 'score', type: 'uint8' },
      { name: 'tag1', type: 'bytes32' },
      { name: 'tag2', type: 'bytes32' },
      { name: 'isRevoked', type: 'bool' },
    ],
  },
  {
    name: 'readFullFeedback',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'client', type: 'address' },
          { name: 'score', type: 'uint8' },
          { name: 'tag1', type: 'bytes32' },
          { name: 'tag2', type: 'bytes32' },
          { name: 'endpoint', type: 'string' },
          { name: 'feedbackURI', type: 'string' },
          { name: 'feedbackHash', type: 'bytes32' },
          { name: 'timestamp', type: 'uint256' },
          { name: 'revoked', type: 'bool' },
          { name: 'responseURI', type: 'string' },
          { name: 'responseHash', type: 'bytes32' },
        ],
      },
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
    name: 'getFeedbackCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getAverageScore',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint8' }],
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

export function stringToBytes32(str: string): `0x${string}` {
  if (!str) return '0x0000000000000000000000000000000000000000000000000000000000000000';
  const bytes = stringToBytes(str.slice(0, 32));
  const padded = new Uint8Array(32);
  padded.set(bytes);
  return `0x${Buffer.from(padded).toString('hex')}` as `0x${string}`;
}

export function bytes32ToString(bytes32: `0x${string}`): string {
  const hex = bytes32.slice(2);
  const bytes = Buffer.from(hex, 'hex');
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.slice(0, end).toString('utf8');
}

export async function giveFeedback(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: ReputationRegistryState,
  agentId: bigint,
  score: number,
  tag1: string,
  tag2: string,
  endpoint: string,
  feedbackURI: string,
  feedbackHash: `0x${string}`
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  if (score < 0 || score > 100) {
    throw new Error('Score must be between 0 and 100');
  }

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'giveFeedback',
    args: [
      agentId,
      score,
      stringToBytes32(tag1),
      stringToBytes32(tag2),
      endpoint,
      feedbackURI,
      feedbackHash,
    ],
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
  clientAddresses: `0x${string}`[] = [],
  tag1: string = '',
  tag2: string = ''
): Promise<FeedbackSummary> {
  const [count, averageScore] = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'getSummary',
    args: [agentId, clientAddresses, stringToBytes32(tag1), stringToBytes32(tag2)],
  });

  return {
    count: Number(count),
    averageScore,
  };
}

export async function readFeedback(
  publicClient: PublicClient,
  state: ReputationRegistryState,
  agentId: bigint,
  clientAddress: `0x${string}`,
  feedbackIndex: bigint
): Promise<{ score: number; tag1: string; tag2: string; isRevoked: boolean }> {
  const [score, tag1, tag2, isRevoked] = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'readFeedback',
    args: [agentId, clientAddress, feedbackIndex],
  });

  return {
    score,
    tag1: bytes32ToString(tag1),
    tag2: bytes32ToString(tag2),
    isRevoked,
  };
}

export async function readFullFeedback(
  publicClient: PublicClient,
  state: ReputationRegistryState,
  agentId: bigint,
  clientAddress: `0x${string}`,
  feedbackIndex: bigint
): Promise<Feedback> {
  const result = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'readFullFeedback',
    args: [agentId, clientAddress, feedbackIndex],
  });

  return {
    client: result.client,
    score: result.score,
    tag1: result.tag1,
    tag2: result.tag2,
    endpoint: result.endpoint,
    feedbackURI: result.feedbackURI,
    feedbackHash: result.feedbackHash,
    timestamp: result.timestamp,
    revoked: result.revoked,
    responseURI: result.responseURI,
    responseHash: result.responseHash,
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

export async function getFeedbackCount(
  publicClient: PublicClient,
  state: ReputationRegistryState,
  agentId: bigint
): Promise<bigint> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'getFeedbackCount',
    args: [agentId],
  });
}

export async function getAverageScore(
  publicClient: PublicClient,
  state: ReputationRegistryState,
  agentId: bigint
): Promise<number> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_REPUTATION_REGISTRY_ABI,
    functionName: 'getAverageScore',
    args: [agentId],
  });
}
