import type { PublicClient } from 'viem';
import { decodeEventLog, keccak256, parseAbiItem, toBytes } from 'viem';
import { getERC8004Addresses } from '@ecco/contracts/addresses';
import type { WalletState } from '../payments/wallet';
import { getPublicClient } from '../payments/wallet';
import {
  computePeerIdHash,
  createIdentityRegistryState,
  createReputationRegistryState,
  getAgentOwner,
  getAgentWallet,
  getClients,
  getSummary,
  readAllFeedback,
  valueToNumber,
} from '../identity';
import type { IdentityRegistryState, ReputationRegistryState, StakeInfo, StakeRegistryState } from '../identity';
import { createStakeRegistryState, fetchStakeInfo, canWork } from '../identity/stake-registry';
import { REPUTATION } from '../networking/constants';
import { clamp } from '../utils/validation';

const ZERO_ADDRESS: `0x${string}` = '0x0000000000000000000000000000000000000000';
const METADATA_SET_EVENT = parseAbiItem('event MetadataSet(uint256 indexed agentId,string indexed indexedMetadataKey,string metadataKey,bytes metadataValue)');

const STAKE_REGISTRY_ADDRESS: `0x${string}` = ZERO_ADDRESS;

export interface LocalPeerReputation {
  peerId: string;
  walletAddress: string | null;
  agentId?: bigint;
  localScore: number;
  onChainScore: bigint | null;
  feedbackScore: number | null;
  feedbackCount: number;
  stake: bigint;
  canWork: boolean;
  totalJobs: number;
  successfulJobs: number;
  failedJobs: number;
  pendingRatings: PendingRating[];
  lastSyncedAt: number;
  lastInteractionAt: number;
}

export interface PendingRating {
  paymentId: `0x${string}`;
  txHash: string;
  payee: string;
  amount: bigint;
  delta: number;
  timestamp: number;
  recorded: boolean;
}

export interface ReputationState {
  peers: Map<string, LocalPeerReputation>;
  peerIdToWallet: Map<string, `0x${string}`>;
  peerIdToAgentId: Map<string, bigint>;
  pendingCommits: PendingRating[];
  commitThreshold: number;
  commitIntervalMs: number;
  lastCommitAt: number;
  chainId: number;
  syncIntervalMs: number;
  identityRegistryAddress: `0x${string}`;
  reputationRegistryAddress: `0x${string}`;
  peerResolver?: PeerResolver;
}

export interface PeerResolverResult {
  agentId?: bigint;
  walletAddress?: `0x${string}`;
}

export type PeerResolver = (peerId: string) => Promise<PeerResolverResult | null>;

export interface ReputationConfig {
  chainId: number;
  commitThreshold?: number;
  commitIntervalMs?: number;
  syncIntervalMs?: number;
  peerResolver?: PeerResolver;
  identityRegistryAddress?: `0x${string}`;
  reputationRegistryAddress?: `0x${string}`;
}

export function resolveRegistryAddresses(
  chainId: number,
  overrides: {
    identityRegistryAddress?: `0x${string}`;
    reputationRegistryAddress?: `0x${string}`;
  } = {}
): { identityRegistryAddress: `0x${string}`; reputationRegistryAddress: `0x${string}` } {
  const addresses = getERC8004Addresses(chainId);
  return {
    identityRegistryAddress: overrides.identityRegistryAddress ?? addresses?.identityRegistry ?? ZERO_ADDRESS,
    reputationRegistryAddress: overrides.reputationRegistryAddress ?? addresses?.reputationRegistry ?? ZERO_ADDRESS,
  };
}

function getIdentityState(chainId: number, identityRegistryAddress: `0x${string}`): IdentityRegistryState {
  return createIdentityRegistryState(chainId, identityRegistryAddress);
}

function getReputationRegistryState(
  chainId: number,
  reputationRegistryAddress: `0x${string}`,
  identityRegistryAddress: `0x${string}`
): ReputationRegistryState {
  return createReputationRegistryState(chainId, reputationRegistryAddress, identityRegistryAddress);
}

function getStakeState(chainId: number, identityRegistryAddress: `0x${string}`): StakeRegistryState {
  return createStakeRegistryState(chainId, STAKE_REGISTRY_ADDRESS, identityRegistryAddress);
}

export function createReputationState(config: ReputationConfig): ReputationState {
  const addresses = resolveRegistryAddresses(config.chainId, {
    identityRegistryAddress: config.identityRegistryAddress,
    reputationRegistryAddress: config.reputationRegistryAddress,
  });
  return {
    peers: new Map(),
    peerIdToWallet: new Map(),
    peerIdToAgentId: new Map(),
    pendingCommits: [],
    commitThreshold: config.commitThreshold ?? REPUTATION.DEFAULT_COMMIT_THRESHOLD,
    commitIntervalMs: config.commitIntervalMs ?? REPUTATION.DEFAULT_COMMIT_INTERVAL_MS,
    lastCommitAt: Date.now(),
    chainId: config.chainId,
    syncIntervalMs: config.syncIntervalMs ?? REPUTATION.DEFAULT_SYNC_INTERVAL_MS,
    identityRegistryAddress: addresses.identityRegistryAddress,
    reputationRegistryAddress: addresses.reputationRegistryAddress,
    peerResolver: config.peerResolver,
  };
}

export function createDefaultPeerResolver(config: {
  chainId: number;
  wallet: WalletState;
  identityRegistryAddress: `0x${string}`;
}): PeerResolver {
  const publicClient = getPublicClient(config.wallet, config.chainId);
  const identityState = createIdentityRegistryState(config.chainId, config.identityRegistryAddress);

  return async (peerId: string): Promise<PeerResolverResult | null> => {
    if (config.identityRegistryAddress === ZERO_ADDRESS) {
      return null;
    }

    const peerIdHash = computePeerIdHash(peerId);

    let logs: Awaited<ReturnType<PublicClient['getLogs']>> = [];
    try {
      logs = await publicClient.getLogs({
        address: config.identityRegistryAddress,
        event: METADATA_SET_EVENT,
        fromBlock: 0n,
        toBlock: 'latest',
      });
    } catch {
      return null;
    }

    let matchedAgentId: bigint | null = null;
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: [METADATA_SET_EVENT],
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName !== 'MetadataSet') {
          continue;
        }
        const args = decoded.args;
        if (!args || typeof args !== 'object') {
          continue;
        }
        const indexedMetadataKey = 'indexedMetadataKey' in args && typeof args.indexedMetadataKey === 'string'
          ? args.indexedMetadataKey
          : null;
        const metadataValue = 'metadataValue' in args && typeof args.metadataValue === 'string'
          ? args.metadataValue
          : null;
        const agentId = 'agentId' in args && typeof args.agentId === 'bigint'
          ? args.agentId
          : null;
        if (!indexedMetadataKey || !metadataValue || agentId === null) {
          continue;
        }
        if (indexedMetadataKey !== 'peerIdHash') {
          continue;
        }
        if (metadataValue.toLowerCase() !== peerIdHash.toLowerCase()) {
          continue;
        }
        matchedAgentId = agentId;
      } catch {
        continue;
      }
    }

    if (matchedAgentId === null) {
      return null;
    }

    const agentId = matchedAgentId;

    let walletAddress: `0x${string}` | null = null;
    try {
      const agentWallet = await getAgentWallet(publicClient, identityState, agentId);
      if (agentWallet !== ZERO_ADDRESS) {
        walletAddress = agentWallet;
      }
    } catch {
    }

    if (!walletAddress) {
      try {
        walletAddress = await getAgentOwner(publicClient, identityState, agentId);
      } catch {
      }
    }

    if (!walletAddress) {
      return { agentId };
    }

    return { agentId, walletAddress };
  };
}

export function getLocalReputation(state: ReputationState, peerId: string): LocalPeerReputation | undefined {
  return state.peers.get(peerId);
}

export function updateLocalScore(state: ReputationState, peerId: string, delta: number): void {
  const peer = state.peers.get(peerId);
  if (!peer) return;

  const newScore = peer.localScore + delta;
  const clampedScore = Math.max(REPUTATION.MIN_LOCAL_SCORE, Math.min(REPUTATION.MAX_LOCAL_SCORE, newScore));
  if (clampedScore !== newScore) {
    console.warn(`[reputation] Score for peer ${peerId} clamped: ${newScore} -> ${clampedScore}`);
  }

  const updatedPeer: LocalPeerReputation = {
    ...peer,
    localScore: clampedScore,
    lastInteractionAt: Date.now(),
    successfulJobs: delta > 0 ? peer.successfulJobs + 1 : peer.successfulJobs,
    failedJobs: delta < 0 ? peer.failedJobs + 1 : peer.failedJobs,
    totalJobs: peer.totalJobs + 1,
  };

  state.peers.set(peerId, updatedPeer);
}

export function recordLocalSuccess(state: ReputationState, peerId: string, walletAddress?: string): void {
  const now = Date.now();
  const existingPeer = state.peers.get(peerId);

  const basePeer: LocalPeerReputation = existingPeer ?? {
    peerId,
    walletAddress: walletAddress ?? null,
    localScore: 0,
    onChainScore: null,
    feedbackScore: null,
    feedbackCount: 0,
    stake: 0n,
    canWork: false,
    totalJobs: 0,
    successfulJobs: 0,
    failedJobs: 0,
    pendingRatings: [],
    lastSyncedAt: 0,
    lastInteractionAt: now,
  };

  const updatedPeer: LocalPeerReputation = {
    ...basePeer,
    localScore: Math.min(REPUTATION.MAX_LOCAL_SCORE, basePeer.localScore + 1),
    successfulJobs: basePeer.successfulJobs + 1,
    totalJobs: basePeer.totalJobs + 1,
    lastInteractionAt: now,
    walletAddress: walletAddress && !basePeer.walletAddress ? walletAddress : basePeer.walletAddress,
  };

  state.peers.set(peerId, updatedPeer);
}

export function recordLocalFailure(state: ReputationState, peerId: string, walletAddress?: string): void {
  const now = Date.now();
  const existingPeer = state.peers.get(peerId);

  const basePeer: LocalPeerReputation = existingPeer ?? {
    peerId,
    walletAddress: walletAddress ?? null,
    localScore: 0,
    onChainScore: null,
    feedbackScore: null,
    feedbackCount: 0,
    stake: 0n,
    canWork: false,
    totalJobs: 0,
    successfulJobs: 0,
    failedJobs: 0,
    pendingRatings: [],
    lastSyncedAt: 0,
    lastInteractionAt: now,
  };

  const updatedPeer: LocalPeerReputation = {
    ...basePeer,
    localScore: Math.max(REPUTATION.MIN_LOCAL_SCORE, basePeer.localScore - 1),
    failedJobs: basePeer.failedJobs + 1,
    totalJobs: basePeer.totalJobs + 1,
    lastInteractionAt: now,
    walletAddress: walletAddress && !basePeer.walletAddress ? walletAddress : basePeer.walletAddress,
  };

  state.peers.set(peerId, updatedPeer);
}

export function generatePaymentId(
  txHash: string,
  payer: string,
  payee: string,
  timestamp: number
): `0x${string}` {
  const data = `${txHash}:${payer}:${payee}:${timestamp}`;
  return keccak256(toBytes(data));
}

export async function queueRating(
  state: ReputationState,
  wallet: WalletState,
  peerId: string,
  payeeAddress: `0x${string}`,
  txHash: string,
  amount: bigint,
  delta: number
): Promise<void> {
  if (state.pendingCommits.length >= REPUTATION.MAX_PENDING_RATINGS) {
    return;
  }

  const paymentId = generatePaymentId(txHash, wallet.account.address, payeeAddress, Date.now());

  const rating: PendingRating = {
    paymentId,
    txHash,
    payee: payeeAddress,
    amount,
    delta: Math.max(-5, Math.min(5, delta)),
    timestamp: Date.now(),
    recorded: false,
  };

  const peer = state.peers.get(peerId);
  if (peer) {
    const trimmedRatings =
      peer.pendingRatings.length >= REPUTATION.MAX_PENDING_RATINGS
        ? peer.pendingRatings.slice(1)
        : peer.pendingRatings;

    const updatedPeer: LocalPeerReputation = {
      ...peer,
      pendingRatings: [...trimmedRatings, rating],
    };
    state.peers.set(peerId, updatedPeer);
  }

  state.pendingCommits = [...state.pendingCommits, rating];
}

export async function commitPendingRatings(
  state: ReputationState,
  wallet: WalletState
): Promise<{ committed: number; failed: number }> {
  const unrecorded = state.pendingCommits.filter((r) => !r.recorded);

  if (unrecorded.length === 0) {
    return { committed: 0, failed: 0 };
  }

  state.pendingCommits = state.pendingCommits.filter((r) => r.recorded);
  state.lastCommitAt = Date.now();

  return { committed: 0, failed: unrecorded.length };
}

export function shouldCommit(state: ReputationState): boolean {
  const now = Date.now();
  const pendingCount = state.pendingCommits.filter((r) => !r.recorded).length;

  if (pendingCount >= state.commitThreshold) {
    return true;
  }

  if (now - state.lastCommitAt >= state.commitIntervalMs && pendingCount > 0) {
    return true;
  }

  return false;
}

async function fetchFeedbackSignal(
  publicClient: PublicClient,
  reputationRegistryState: ReputationRegistryState,
  agentId: bigint
): Promise<{ score: number | null; count: number }> {
  let clients: `0x${string}`[] = [];
  try {
    clients = await getClients(publicClient, reputationRegistryState, agentId);
  } catch {
    return { score: null, count: 0 };
  }

  if (clients.length === 0) {
    return { score: null, count: 0 };
  }

  let summaryScore: number | null = null;
  let summaryCount = 0;

  try {
    const summary = await getSummary(publicClient, reputationRegistryState, agentId, clients);
    summaryCount = summary.count;
    if (summary.count > 0) {
      summaryScore = valueToNumber(summary.averageValue, summary.maxDecimals);
    }
  } catch {
  }

  try {
    const feedback = await readAllFeedback(publicClient, reputationRegistryState, agentId, clients);
    let total = 0;
    let count = 0;
    for (let i = 0; i < feedback.values.length; i += 1) {
      if (feedback.revokedStatuses[i]) continue;
      total += valueToNumber(feedback.values[i], feedback.valueDecimalsArr[i]);
      count += 1;
    }
    if (count > 0) {
      const average = total / count;
      if (summaryScore === null) {
        summaryScore = average;
      }
      if (summaryCount === 0) {
        summaryCount = count;
      }
    }
  } catch {
  }

  return { score: summaryScore, count: summaryCount };
}

export async function syncPeerFromChain(
  state: ReputationState,
  wallet: WalletState,
  peerId: string,
  walletAddress: `0x${string}`
): Promise<LocalPeerReputation> {
  const publicClient = getPublicClient(wallet, state.chainId);
  const identityState = getIdentityState(state.chainId, state.identityRegistryAddress);
  const stakeState = getStakeState(state.chainId, state.identityRegistryAddress);
  const reputationRegistryState = getReputationRegistryState(
    state.chainId,
    state.reputationRegistryAddress,
    state.identityRegistryAddress
  );

  const now = Date.now();
  const existingPeer = state.peers.get(peerId);

  let stakeInfo: StakeInfo | null = null;
  let resolvedAgentId: bigint | null = null;
  let feedbackScore = existingPeer?.feedbackScore ?? null;
  let feedbackCount = existingPeer?.feedbackCount ?? 0;

  try {
    resolvedAgentId = await resolveAgentIdForPeer(state, wallet, peerId);
    if (resolvedAgentId !== null) {
      stakeInfo = await fetchStakeInfo(publicClient, stakeState, resolvedAgentId);
    }
  } catch {
  }

  if (resolvedAgentId !== null && state.reputationRegistryAddress !== ZERO_ADDRESS) {
    try {
      const feedback = await fetchFeedbackSignal(publicClient, reputationRegistryState, resolvedAgentId);
      feedbackScore = feedback.score;
      feedbackCount = feedback.count;
    } catch {
    }
  }

  let canWorkResult = false;
  try {
    canWorkResult = await canWork(publicClient, stakeState, walletAddress);
  } catch {
  }

  const basePeer: LocalPeerReputation = existingPeer ?? {
    peerId,
    walletAddress,
    localScore: 0,
    onChainScore: null,
    feedbackScore: null,
    feedbackCount: 0,
    stake: 0n,
    canWork: false,
    totalJobs: 0,
    successfulJobs: 0,
    failedJobs: 0,
    pendingRatings: [],
    lastSyncedAt: now,
    lastInteractionAt: now,
  };

  const updatedPeer: LocalPeerReputation = {
    ...basePeer,
    agentId: resolvedAgentId ?? basePeer.agentId,
    onChainScore: stakeInfo?.effectiveScore ?? null,
    feedbackScore,
    feedbackCount,
    stake: stakeInfo?.stake ?? 0n,
    canWork: canWorkResult,
    lastSyncedAt: now,
    walletAddress,
  };

  state.peers.set(peerId, updatedPeer);
  return updatedPeer;
}

export async function syncAllPeersFromChain(
  state: ReputationState,
  wallet: WalletState
): Promise<number> {
  const now = Date.now();
  const staleThreshold = now - state.syncIntervalMs;
  let synced = 0;

  for (const [peerId, peer] of state.peers) {
    if (peer.walletAddress && peer.lastSyncedAt < staleThreshold) {
      try {
        await syncPeerFromChain(state, wallet, peerId, peer.walletAddress as `0x${string}`);
        synced += 1;
      } catch {
        continue;
      }
    }
  }

  return synced;
}

export function getEffectiveScore(peer: LocalPeerReputation): number {
  let score = peer.localScore;

  if (peer.onChainScore !== null) {
    score += Number(peer.onChainScore) / 1e18;
  }

  if (peer.feedbackScore !== null) {
    const clamped = clamp(peer.feedbackScore, -100, 100);
    const weight = peer.feedbackCount > 0 ? Math.min(1, Math.log10(peer.feedbackCount + 1)) : 0;
    score += clamped * weight;
  }

  return score;
}

export function getDiscoveryReputationScore(peer: LocalPeerReputation): number {
  if (peer.feedbackScore !== null && peer.feedbackCount > 0) {
    const clamped = clamp(peer.feedbackScore, -100, 100);
    const weight = Math.min(1, Math.log10(peer.feedbackCount + 1));
    return clamp(clamped * weight, -100, 100);
  }

  return clamp(getEffectiveScore(peer), -100, 100);
}

export function getPeersByScore(state: ReputationState, limit?: number): LocalPeerReputation[] {
  const peers = Array.from(state.peers.values());
  peers.sort((a, b) => getEffectiveScore(b) - getEffectiveScore(a));

  if (limit) {
    return peers.slice(0, limit);
  }
  return peers;
}

export function getStakedPeers(state: ReputationState): LocalPeerReputation[] {
  return Array.from(state.peers.values()).filter((p) => p.canWork);
}

export function getCachedWallet(state: ReputationState, peerId: string): `0x${string}` | undefined {
  return state.peerIdToWallet.get(peerId);
}

export function setCachedWallet(state: ReputationState, peerId: string, wallet: `0x${string}`): void {
  state.peerIdToWallet.set(peerId, wallet);
  const peer = state.peers.get(peerId);
  if (peer) {
    state.peers.set(peerId, { ...peer, walletAddress: wallet });
  }
}

function cachePeerResolution(state: ReputationState, peerId: string, result: PeerResolverResult): void {
  if (result.agentId !== undefined) {
    state.peerIdToAgentId.set(peerId, result.agentId);
  }
  if (result.walletAddress) {
    state.peerIdToWallet.set(peerId, result.walletAddress);
  }
  const peer = state.peers.get(peerId);
  if (peer) {
    state.peers.set(peerId, {
      ...peer,
      walletAddress: result.walletAddress ?? peer.walletAddress,
      agentId: result.agentId ?? peer.agentId,
    });
  }
}

async function resolveFromResolver(state: ReputationState, peerId: string): Promise<PeerResolverResult | null> {
  if (!state.peerResolver) {
    return null;
  }
  const result = await state.peerResolver(peerId);
  if (!result) {
    return null;
  }
  cachePeerResolution(state, peerId, result);
  return result;
}

export async function resolvePeerIdentity(
  state: ReputationState,
  wallet: WalletState,
  peerId: string
): Promise<{ agentId: bigint | null; walletAddress: `0x${string}` | null }> {
  const cachedWallet = state.peerIdToWallet.get(peerId) ?? null;
  const cachedAgentId = state.peerIdToAgentId.get(peerId) ?? null;

  let agentId = cachedAgentId;
  let walletAddress = cachedWallet;

  const resolved = (agentId === null || walletAddress === null)
    ? await resolveFromResolver(state, peerId)
    : null;
  if (resolved?.agentId !== undefined) {
    agentId = resolved.agentId;
  }
  if (resolved?.walletAddress) {
    walletAddress = resolved.walletAddress;
  }

  if (!walletAddress && agentId !== null) {
    const publicClient = getPublicClient(wallet, state.chainId);
    if (state.identityRegistryAddress !== ZERO_ADDRESS) {
      const identityState = getIdentityState(state.chainId, state.identityRegistryAddress);
      try {
        const agentWallet = await getAgentWallet(publicClient, identityState, agentId);
        if (agentWallet !== ZERO_ADDRESS) {
          walletAddress = agentWallet;
        }
      } catch {
      }
      if (!walletAddress) {
        try {
          walletAddress = await getAgentOwner(publicClient, identityState, agentId);
        } catch {
        }
      }
      if (walletAddress) {
        cachePeerResolution(state, peerId, { agentId, walletAddress });
      }
    }
  }

  return { agentId, walletAddress };
}

export async function resolveWalletForPeer(
  state: ReputationState,
  wallet: WalletState,
  peerId: string
): Promise<`0x${string}` | null> {
  const resolved = await resolvePeerIdentity(state, wallet, peerId);
  return resolved.walletAddress;
}

export async function resolveAgentIdForPeer(
  state: ReputationState,
  wallet: WalletState,
  peerId: string
): Promise<bigint | null> {
  const resolved = await resolvePeerIdentity(state, wallet, peerId);
  return resolved.agentId;
}

export async function resolveAndSyncPeer(
  state: ReputationState,
  wallet: WalletState,
  peerId: string
): Promise<LocalPeerReputation | null> {
  const { walletAddress } = await resolvePeerIdentity(state, wallet, peerId);
  if (!walletAddress) {
    return null;
  }

  return syncPeerFromChain(state, wallet, peerId, walletAddress);
}

export function calculateLocalSuccessRate(peer: LocalPeerReputation): number {
  if (peer.totalJobs === 0) return 0;
  return peer.successfulJobs / peer.totalJobs;
}

export function clearStaleEntries(state: ReputationState, maxAgeMs: number): number {
  const now = Date.now();
  const threshold = now - maxAgeMs;
  let removed = 0;

  for (const [peerId, peer] of state.peers) {
    if (peer.lastInteractionAt < threshold && peer.pendingRatings.length === 0) {
      state.peers.delete(peerId);
      removed += 1;
    }
  }

  return removed;
}

export function createReputationScorer(state: ReputationState | undefined): (peerId: string) => number {
  return (peerId: string): number => {
    if (!state) {
      return 0;
    }
    const rep = state.peers.get(peerId);
    if (!rep) {
      return 0;
    }
    return getDiscoveryReputationScore(rep);
  };
}
