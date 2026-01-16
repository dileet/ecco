import type { PublicClient, WalletClient } from 'viem';
import { keccak256, toBytes, encodeAbiParameters, parseAbiParameters, encodeFunctionData } from 'viem';
import type { IdentityRegistryState, AgentInfo, AgentStake, MetadataEntry, StakeInfo } from './types';
import { formatGlobalId } from './global-id';

const AGENT_IDENTITY_REGISTRY_ABI = [
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    name: 'setAgentURI',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newURI', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'agentURI',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'getMetadata',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'key', type: 'string' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    name: 'setMetadata',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'key', type: 'string' },
      { name: 'value', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'ownerOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getGlobalId',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'getAgentByPeerIdHash',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'peerIdHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
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

export function createIdentityRegistryState(
  chainId: number,
  registryAddress: `0x${string}`
): IdentityRegistryState {
  return {
    chainId,
    registryAddress,
    cachedAgents: new Map(),
    peerIdToAgentId: new Map(),
  };
}

export function computePeerIdHash(peerId: string): `0x${string}` {
  return keccak256(toBytes(peerId));
}

export async function registerAgent(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: IdentityRegistryState,
  agentURI: string
): Promise<{ agentId: bigint; txHash: `0x${string}` }> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'register',
    args: [agentURI],
    account,
  });

  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  const registeredEvent = receipt.logs.find((log) => {
    return log.topics[0] === keccak256(toBytes('Registered(uint256,address,string)'));
  });

  if (!registeredEvent || !registeredEvent.topics[1]) {
    throw new Error('Failed to find Registered event');
  }

  const agentId = BigInt(registeredEvent.topics[1]);

  const agentInfo: AgentInfo = {
    agentId,
    owner: account.address,
    agentURI,
    globalId: formatGlobalId(state.chainId, state.registryAddress, agentId),
  };
  state.cachedAgents.set(agentId, agentInfo);

  return { agentId, txHash };
}

export async function getAgentURI(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  agentId: bigint
): Promise<string> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'agentURI',
    args: [agentId],
  });
}

export async function setAgentURI(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: IdentityRegistryState,
  agentId: bigint,
  newURI: string
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'setAgentURI',
    args: [agentId, newURI],
    account,
  });

  return walletClient.writeContract(request);
}

export async function getMetadata(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  agentId: bigint,
  key: string
): Promise<`0x${string}`> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'getMetadata',
    args: [agentId, key],
  });
}

export async function setMetadata(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: IdentityRegistryState,
  agentId: bigint,
  key: string,
  value: `0x${string}`
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'setMetadata',
    args: [agentId, key, value],
    account,
  });

  return walletClient.writeContract(request);
}

export async function getAgentOwner(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  agentId: bigint
): Promise<`0x${string}`> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'ownerOf',
    args: [agentId],
  });
}

export async function getAgentByPeerIdHash(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  peerIdHash: `0x${string}`
): Promise<bigint> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'getAgentByPeerIdHash',
    args: [peerIdHash],
  });
}

export async function getAgentByPeerId(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  peerId: string
): Promise<bigint> {
  const cached = state.peerIdToAgentId.get(peerId);
  if (cached !== undefined) {
    return cached;
  }

  const peerIdHash = computePeerIdHash(peerId);
  const agentId = await getAgentByPeerIdHash(publicClient, state, peerIdHash);

  if (agentId > 0n) {
    state.peerIdToAgentId.set(peerId, agentId);
  }

  return agentId;
}

export async function getAgentStake(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  agentId: bigint
): Promise<AgentStake> {
  const [stake, lastActive, unstakeRequestTime, unstakeAmount] = await publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
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

export async function stakeForAgent(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: IdentityRegistryState,
  agentId: bigint,
  amount: bigint
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'stake',
    args: [agentId, amount],
    account,
  });

  return walletClient.writeContract(request);
}

export async function requestUnstake(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: IdentityRegistryState,
  agentId: bigint,
  amount: bigint
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'requestUnstake',
    args: [agentId, amount],
    account,
  });

  return walletClient.writeContract(request);
}

export async function completeUnstake(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: IdentityRegistryState,
  agentId: bigint
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'completeUnstake',
    args: [agentId],
    account,
  });

  return walletClient.writeContract(request);
}

export async function canWork(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  wallet: `0x${string}`
): Promise<boolean> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'canWork',
    args: [wallet],
  });
}

export async function canWorkAgent(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  agentId: bigint
): Promise<boolean> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'canWorkAgent',
    args: [agentId],
  });
}

export async function getTotalStaked(
  publicClient: PublicClient,
  state: IdentityRegistryState
): Promise<bigint> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'totalStaked',
  });
}

export async function getMinStakeToWork(
  publicClient: PublicClient,
  state: IdentityRegistryState
): Promise<bigint> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'minStakeToWork',
  });
}

export async function getStakeInfo(
  publicClient: PublicClient,
  state: IdentityRegistryState,
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

export async function getStakeInfoByWallet(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  walletAddress: `0x${string}`
): Promise<StakeInfo> {
  const canWorkResult = await canWork(publicClient, state, walletAddress);

  return {
    stake: 0n,
    canWork: canWorkResult,
    effectiveScore: 0n,
    agentId: undefined,
  };
}

export async function getAgentInfo(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  agentId: bigint
): Promise<AgentInfo> {
  const cached = state.cachedAgents.get(agentId);
  if (cached) {
    return cached;
  }

  const [owner, uri, stake] = await Promise.all([
    getAgentOwner(publicClient, state, agentId),
    getAgentURI(publicClient, state, agentId),
    getAgentStake(publicClient, state, agentId),
  ]);

  let peerId: string | undefined;
  let peerIdHash: `0x${string}` | undefined;

  try {
    const peerIdBytes = await getMetadata(publicClient, state, agentId, 'peerId');
    if (peerIdBytes && peerIdBytes !== '0x') {
      peerId = new TextDecoder().decode(Buffer.from(peerIdBytes.slice(2), 'hex'));
    }
    const peerIdHashBytes = await getMetadata(publicClient, state, agentId, 'peerIdHash');
    if (peerIdHashBytes && peerIdHashBytes.length === 66) {
      peerIdHash = peerIdHashBytes as `0x${string}`;
    }
  } catch {
  }

  const agentInfo: AgentInfo = {
    agentId,
    owner,
    agentURI: uri,
    peerId,
    peerIdHash,
    stake,
    globalId: formatGlobalId(state.chainId, state.registryAddress, agentId),
  };

  state.cachedAgents.set(agentId, agentInfo);
  if (peerId) {
    state.peerIdToAgentId.set(peerId, agentId);
  }

  return agentInfo;
}

export function clearAgentCache(state: IdentityRegistryState, agentId?: bigint): void {
  if (agentId !== undefined) {
    const cached = state.cachedAgents.get(agentId);
    if (cached?.peerId) {
      state.peerIdToAgentId.delete(cached.peerId);
    }
    state.cachedAgents.delete(agentId);
  } else {
    state.cachedAgents.clear();
    state.peerIdToAgentId.clear();
  }
}
