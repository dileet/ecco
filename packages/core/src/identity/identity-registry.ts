import type { PublicClient, WalletClient } from 'viem';
import { keccak256, toBytes } from 'viem';
import { z } from 'zod';
import type { IdentityRegistryState, AgentInfo, MetadataEntry } from './types';
import { HexAddressSchema } from './types';
import { formatGlobalId } from './global-id';

const AGENT_IDENTITY_REGISTRY_ABI = [
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentURI', type: 'string' },
      {
        name: 'metadata',
        type: 'tuple[]',
        components: [
          { name: 'metadataKey', type: 'string' },
          { name: 'metadataValue', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
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
    name: 'tokenURI',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'getMetadata',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    name: 'setMetadata',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
      { name: 'metadataValue', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'setAgentWallet',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newWallet', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'getAgentWallet',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'unsetAgentWallet',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'ownerOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const SetAgentWalletDomainSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  chainId: z.number().int().positive(),
  verifyingContract: HexAddressSchema,
});

const SetAgentWalletMessageSchema = z.object({
  agentId: z.bigint(),
  newWallet: HexAddressSchema,
  deadline: z.bigint(),
});

const SET_AGENT_WALLET_TYPES = [
  { name: 'agentId', type: 'uint256' },
  { name: 'newWallet', type: 'address' },
  { name: 'deadline', type: 'uint256' },
] as const;

export interface SetAgentWalletTypedData {
  domain: z.infer<typeof SetAgentWalletDomainSchema>;
  types: {
    SetAgentWallet: typeof SET_AGENT_WALLET_TYPES;
  };
  primaryType: 'SetAgentWallet';
  message: z.infer<typeof SetAgentWalletMessageSchema>;
}

export function createIdentityRegistryState(
  chainId: number,
  registryAddress: `0x${string}`
): IdentityRegistryState {
  return {
    chainId,
    registryAddress,
    cachedAgents: new Map(),
  };
}

export function computePeerIdHash(peerId: string): `0x${string}` {
  return keccak256(toBytes(peerId));
}

export function createSetAgentWalletTypedData(params: {
  chainId: number;
  registryAddress: `0x${string}`;
  agentId: bigint;
  newWallet: `0x${string}`;
  deadline: bigint;
  name?: string;
  version?: string;
}): SetAgentWalletTypedData {
  const domainInput = {
    name: params.name ?? 'ERC8004IdentityRegistry',
    version: params.version ?? '1',
    chainId: params.chainId,
    verifyingContract: params.registryAddress,
  };

  const domainResult = SetAgentWalletDomainSchema.safeParse(domainInput);
  if (!domainResult.success) {
    throw new Error('Invalid EIP-712 domain for setAgentWallet');
  }

  const messageResult = SetAgentWalletMessageSchema.safeParse({
    agentId: params.agentId,
    newWallet: params.newWallet,
    deadline: params.deadline,
  });
  if (!messageResult.success) {
    throw new Error('Invalid EIP-712 message for setAgentWallet');
  }

  return {
    domain: domainResult.data,
    types: { SetAgentWallet: SET_AGENT_WALLET_TYPES },
    primaryType: 'SetAgentWallet',
    message: messageResult.data,
  };
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
    return log.topics[0] === keccak256(toBytes('Registered(uint256,string,address)'));
  });

  if (!registeredEvent || !registeredEvent.topics[1]) {
    throw new Error('Failed to find Registered event');
  }

  const agentId = BigInt(registeredEvent.topics[1]);

  const agentInfo: AgentInfo = {
    agentId,
    owner: account.address,
    agentURI,
    registryId: formatGlobalId(state.chainId, state.registryAddress),
  };
  state.cachedAgents.set(agentId, agentInfo);

  return { agentId, txHash };
}

export async function registerAgentWithMetadata(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: IdentityRegistryState,
  agentURI: string,
  metadata: MetadataEntry[]
): Promise<{ agentId: bigint; txHash: `0x${string}` }> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const hasReservedKey = metadata.some((entry) => entry.metadataKey === 'agentWallet');
  if (hasReservedKey) {
    throw new Error('agentWallet is a reserved metadata key and cannot be set via register()');
  }

  const formattedMetadata = metadata.map((entry) => ({
    metadataKey: entry.metadataKey,
    metadataValue: Buffer.from(entry.metadataValue).length ? (`0x${Buffer.from(entry.metadataValue).toString('hex')}` as `0x${string}`) : '0x',
  }));

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'register',
    args: [agentURI, formattedMetadata],
    account,
  });

  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  const registeredEvent = receipt.logs.find((log) => {
    return log.topics[0] === keccak256(toBytes('Registered(uint256,string,address)'));
  });

  if (!registeredEvent || !registeredEvent.topics[1]) {
    throw new Error('Failed to find Registered event');
  }

  const agentId = BigInt(registeredEvent.topics[1]);

  const agentInfo: AgentInfo = {
    agentId,
    owner: account.address,
    agentURI,
    registryId: formatGlobalId(state.chainId, state.registryAddress),
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
    functionName: 'tokenURI',
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

  if (key === 'agentWallet') {
    throw new Error('agentWallet is a reserved metadata key and cannot be set via setMetadata()');
  }

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'setMetadata',
    args: [agentId, key, value],
    account,
  });

  return walletClient.writeContract(request);
}

export async function setAgentWallet(
  publicClient: PublicClient,
  walletClient: WalletClient,
  state: IdentityRegistryState,
  agentId: bigint,
  newWallet: `0x${string}`,
  deadline: bigint,
  signature: `0x${string}`
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account');

  const { request } = await publicClient.simulateContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'setAgentWallet',
    args: [agentId, newWallet, deadline, signature],
    account,
  });

  return walletClient.writeContract(request);
}

export async function getAgentWallet(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  agentId: bigint
): Promise<`0x${string}`> {
  return publicClient.readContract({
    address: state.registryAddress,
    abi: AGENT_IDENTITY_REGISTRY_ABI,
    functionName: 'getAgentWallet',
    args: [agentId],
  });
}

export async function unsetAgentWallet(
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
    functionName: 'unsetAgentWallet',
    args: [agentId],
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

export async function getAgentInfo(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  agentId: bigint
): Promise<AgentInfo> {
  const cached = state.cachedAgents.get(agentId);
  if (cached) {
    return cached;
  }

  const [owner, uri] = await Promise.all([
    getAgentOwner(publicClient, state, agentId),
    getAgentURI(publicClient, state, agentId),
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
    registryId: formatGlobalId(state.chainId, state.registryAddress),
  };

  state.cachedAgents.set(agentId, agentInfo);

  return agentInfo;
}

export function clearAgentCache(state: IdentityRegistryState, agentId?: bigint): void {
  if (agentId !== undefined) {
    const cached = state.cachedAgents.get(agentId);
    state.cachedAgents.delete(agentId);
  } else {
    state.cachedAgents.clear();
  }
}
