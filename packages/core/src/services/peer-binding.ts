import { keccak256, toBytes } from 'viem';
import { getContract } from 'viem';
import type { WalletState } from './wallet';
import { getPublicClient } from './wallet';
import { REPUTATION_REGISTRY_ABI, getContractAddresses } from '@ecco/contracts';

export function computePeerIdHash(peerId: string): `0x${string}` {
  return keccak256(toBytes(peerId.toLowerCase()));
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

export async function getWalletForPeerId(
  state: WalletState,
  chainId: number,
  peerId: string
): Promise<`0x${string}` | null> {
  const peerIdHash = computePeerIdHash(peerId);
  const contract = getReputationContract(state, chainId);
  const wallet = await contract.read.walletOf([peerIdHash]);
  
  if (wallet === '0x0000000000000000000000000000000000000000') {
    return null;
  }
  
  return wallet as `0x${string}`;
}

export async function getPeerIdForWallet(
  state: WalletState,
  chainId: number,
  wallet: `0x${string}`
): Promise<`0x${string}` | null> {
  const contract = getReputationContract(state, chainId);
  const peerIdHash = await contract.read.peerIdOf([wallet]);
  
  if (peerIdHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
    return null;
  }
  
  return peerIdHash as `0x${string}`;
}

export async function isPeerIdRegistered(
  state: WalletState,
  chainId: number,
  peerId: string
): Promise<boolean> {
  const wallet = await getWalletForPeerId(state, chainId, peerId);
  return wallet !== null;
}

export async function isWalletRegistered(
  state: WalletState,
  chainId: number,
  wallet: `0x${string}`
): Promise<boolean> {
  const peerIdHash = await getPeerIdForWallet(state, chainId, wallet);
  return peerIdHash !== null;
}

export interface PeerBindingInfo {
  peerId: string;
  peerIdHash: `0x${string}`;
  wallet: `0x${string}` | null;
  isRegistered: boolean;
}

export async function getPeerBindingInfo(
  state: WalletState,
  chainId: number,
  peerId: string
): Promise<PeerBindingInfo> {
  const peerIdHash = computePeerIdHash(peerId);
  const wallet = await getWalletForPeerId(state, chainId, peerId);
  
  return {
    peerId,
    peerIdHash,
    wallet,
    isRegistered: wallet !== null,
  };
}
