import type { WalletState } from '../services/wallet';
import {
  getReputation,
  getStakeInfo,
  recordPayment,
  batchRate,
  generatePaymentId,
} from '../services/reputation-contract';
import { getWalletForPeerId, computePeerIdHash } from '../services/peer-binding';
import { REPUTATION } from './constants';

export interface LocalPeerReputation {
  peerId: string;
  walletAddress: string | null;
  localScore: number;
  onChainScore: bigint | null;
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
  pendingCommits: PendingRating[];
  commitThreshold: number;
  commitIntervalMs: number;
  lastCommitAt: number;
  chainId: number;
  syncIntervalMs: number;
}

export interface ReputationConfig {
  chainId: number;
  commitThreshold?: number;
  commitIntervalMs?: number;
  syncIntervalMs?: number;
}

export function createReputationState(config: ReputationConfig): ReputationState {
  return {
    peers: new Map(),
    peerIdToWallet: new Map(),
    pendingCommits: [],
    commitThreshold: config.commitThreshold ?? REPUTATION.DEFAULT_COMMIT_THRESHOLD,
    commitIntervalMs: config.commitIntervalMs ?? REPUTATION.DEFAULT_COMMIT_INTERVAL_MS,
    lastCommitAt: Date.now(),
    chainId: config.chainId,
    syncIntervalMs: config.syncIntervalMs ?? REPUTATION.DEFAULT_SYNC_INTERVAL_MS,
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

  let committed = 0;
  let failed = 0;
  const recordedPaymentIds = new Set<string>();

  for (const rating of unrecorded) {
    try {
      await recordPayment(
        wallet,
        state.chainId,
        rating.paymentId,
        rating.payee as `0x${string}`,
        rating.amount
      );
      recordedPaymentIds.add(rating.paymentId);
    } catch {
      failed += 1;
    }
  }

  const recorded = unrecorded.filter((r) => recordedPaymentIds.has(r.paymentId));
  if (recorded.length > 0) {
    try {
      const ratings = recorded.map((r) => ({
        paymentId: r.paymentId,
        delta: r.delta,
      }));
      await batchRate(wallet, state.chainId, ratings);
      committed = recorded.length;

      state.pendingCommits = state.pendingCommits
        .map((r) => (recordedPaymentIds.has(r.paymentId) ? { ...r, recorded: true } : r))
        .filter((r) => !r.recorded);

      for (const [peerId, peer] of state.peers) {
        const updatedRatings = peer.pendingRatings
          .map((r) => (recordedPaymentIds.has(r.paymentId) ? { ...r, recorded: true } : r))
          .filter((r) => !r.recorded);

        if (updatedRatings.length !== peer.pendingRatings.length) {
          state.peers.set(peerId, { ...peer, pendingRatings: updatedRatings });
        }
      }
    } catch {
      failed += recorded.length;
    }
  }

  state.lastCommitAt = Date.now();
  return { committed, failed };
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

export async function syncPeerFromChain(
  state: ReputationState,
  wallet: WalletState,
  peerId: string,
  walletAddress: `0x${string}`
): Promise<LocalPeerReputation> {
  const [reputation, stakeInfo] = await Promise.all([
    getReputation(wallet, state.chainId, walletAddress),
    getStakeInfo(wallet, state.chainId, walletAddress),
  ]);

  const now = Date.now();
  const existingPeer = state.peers.get(peerId);

  const basePeer: LocalPeerReputation = existingPeer ?? {
    peerId,
    walletAddress,
    localScore: 0,
    onChainScore: null,
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
    onChainScore: reputation.score,
    stake: stakeInfo.stake,
    canWork: stakeInfo.canWork,
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

  return score;
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

export async function resolveWalletForPeer(
  state: ReputationState,
  wallet: WalletState,
  peerId: string
): Promise<`0x${string}` | null> {
  const cached = state.peerIdToWallet.get(peerId);
  if (cached) {
    return cached;
  }

  const walletAddress = await getWalletForPeerId(wallet, state.chainId, peerId);
  if (walletAddress) {
    state.peerIdToWallet.set(peerId, walletAddress);
    const peer = state.peers.get(peerId);
    if (peer) {
      state.peers.set(peerId, { ...peer, walletAddress });
    }
  }

  return walletAddress;
}

export async function resolveAndSyncPeer(
  state: ReputationState,
  wallet: WalletState,
  peerId: string
): Promise<LocalPeerReputation | null> {
  const walletAddress = await resolveWalletForPeer(state, wallet, peerId);
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
    return getEffectiveScore(rep);
  };
}
