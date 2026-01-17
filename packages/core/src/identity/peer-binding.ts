import type { PublicClient } from 'viem';
import type { IdentityRegistryState } from './types';
import {
  computePeerIdHash,
  getAgentByPeerIdHash,
  getMetadata,
  getAgentOwner,
} from './identity-registry';

export { bindPeerId as bindPeerIdToAgent } from './identity-registry';

export async function getAgentIdForPeerId(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  peerId: string
): Promise<bigint | null> {
  const cached = state.peerIdToAgentId.get(peerId);
  if (cached !== undefined) {
    return cached;
  }

  const peerIdHash = computePeerIdHash(peerId);
  const agentId = await getAgentByPeerIdHash(publicClient, state, peerIdHash);

  if (agentId > 0n) {
    state.peerIdToAgentId.set(peerId, agentId);
    return agentId;
  }

  return null;
}

export async function getPeerIdForAgent(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  agentId: bigint
): Promise<string | null> {
  for (const [peerId, cachedAgentId] of state.peerIdToAgentId.entries()) {
    if (cachedAgentId === agentId) {
      return peerId;
    }
  }

  try {
    const peerIdBytes = await getMetadata(publicClient, state, agentId, 'peerId');
    if (peerIdBytes && peerIdBytes !== '0x') {
      const peerId = new TextDecoder().decode(Buffer.from(peerIdBytes.slice(2), 'hex'));
      state.peerIdToAgentId.set(peerId, agentId);
      return peerId;
    }
  } catch {
  }

  return null;
}

export async function getWalletForPeerId(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  peerId: string
): Promise<`0x${string}` | null> {
  const agentId = await getAgentIdForPeerId(publicClient, state, peerId);
  if (agentId === null) {
    return null;
  }

  return getAgentOwner(publicClient, state, agentId);
}

export async function isPeerIdRegistered(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  peerId: string
): Promise<boolean> {
  const agentId = await getAgentIdForPeerId(publicClient, state, peerId);
  return agentId !== null && agentId > 0n;
}

export async function verifyPeerIdBinding(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  agentId: bigint,
  peerId: string
): Promise<boolean> {
  const peerIdHash = computePeerIdHash(peerId);
  const registeredAgentId = await getAgentByPeerIdHash(publicClient, state, peerIdHash);
  return registeredAgentId === agentId;
}

export interface PeerBindingInfo {
  agentId: bigint | null;
  peerId: string;
  peerIdHash: `0x${string}`;
  owner: `0x${string}` | null;
  isBound: boolean;
}

export async function getPeerBindingInfo(
  publicClient: PublicClient,
  state: IdentityRegistryState,
  peerId: string
): Promise<PeerBindingInfo> {
  const peerIdHash = computePeerIdHash(peerId);
  const agentId = await getAgentIdForPeerId(publicClient, state, peerId);

  let owner: `0x${string}` | null = null;
  if (agentId !== null && agentId > 0n) {
    owner = await getAgentOwner(publicClient, state, agentId);
  }

  return {
    agentId,
    peerId,
    peerIdHash,
    owner,
    isBound: agentId !== null && agentId > 0n,
  };
}

export { computePeerIdHash };
