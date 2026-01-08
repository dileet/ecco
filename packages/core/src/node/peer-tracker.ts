import type { PeerPerformanceState } from './peer-performance';
import type { ReputationState } from './reputation';
import type { WalletState } from '../services/wallet';
import {
  recordSuccess as recordPerformanceSuccess,
  recordFailure as recordPerformanceFailure,
  calculatePerformanceScore,
  getMetrics,
} from './peer-performance';
import {
  recordLocalSuccess,
  recordLocalFailure,
  getLocalReputation,
  getEffectiveScore,
  queueRating,
  commitPendingRatings,
  shouldCommit,
  syncPeerFromChain,
} from './reputation';

export interface PeerTrackerState {
  performance: PeerPerformanceState;
  reputation: ReputationState | null;
  wallet: WalletState | null;
  autoCommit: boolean;
  autoSync: boolean;
}

export interface TrackSuccessOptions {
  latencyMs: number;
  throughput?: number;
  walletAddress?: string;
  txHash?: string;
  paymentAmount?: bigint;
  ratingDelta?: number;
}

export interface TrackFailureOptions {
  errorCode?: number;
  walletAddress?: string;
}

export interface PeerScore {
  peerId: string;
  performanceScore: number;
  reputationScore: number;
  combinedScore: number;
  canWork: boolean;
}

export function createPeerTracker(
  performance: PeerPerformanceState,
  reputation: ReputationState | null,
  wallet: WalletState | null,
  options?: { autoCommit?: boolean; autoSync?: boolean }
): PeerTrackerState {
  return {
    performance,
    reputation,
    wallet,
    autoCommit: options?.autoCommit ?? true,
    autoSync: options?.autoSync ?? true,
  };
}

export async function trackSuccess(
  state: PeerTrackerState,
  peerId: string,
  options: TrackSuccessOptions
): Promise<void> {
  recordPerformanceSuccess(state.performance, peerId, options.latencyMs, options.throughput);

  if (state.reputation) {
    recordLocalSuccess(state.reputation, peerId, options.walletAddress);

    if (state.wallet && options.txHash && options.paymentAmount && options.walletAddress) {
      const delta = options.ratingDelta ?? 3;
      await queueRating(
        state.reputation,
        state.wallet,
        peerId,
        options.walletAddress as `0x${string}`,
        options.txHash,
        options.paymentAmount,
        delta
      );

      if (state.autoCommit && shouldCommit(state.reputation)) {
        await commitPendingRatings(state.reputation, state.wallet);
      }
    }
  }
}

export async function trackFailure(
  state: PeerTrackerState,
  peerId: string,
  options?: TrackFailureOptions
): Promise<void> {
  recordPerformanceFailure(state.performance, peerId, options?.errorCode);

  if (state.reputation) {
    recordLocalFailure(state.reputation, peerId, options?.walletAddress);
  }
}

export function getPeerScore(state: PeerTrackerState, peerId: string): PeerScore | null {
  const perfMetrics = getMetrics(state.performance, peerId);
  const perfScore = perfMetrics ? calculatePerformanceScore(perfMetrics) : 0;

  let repScore = 0;
  let canWork = false;

  if (state.reputation) {
    const rep = getLocalReputation(state.reputation, peerId);
    if (rep) {
      repScore = getEffectiveScore(rep);
      canWork = rep.canWork;
    }
  }

  if (!perfMetrics && repScore === 0) {
    return null;
  }

  const performanceWeight = 0.4;
  const reputationWeight = 0.6;

  const combinedScore = perfScore * performanceWeight + repScore * reputationWeight;

  return {
    peerId,
    performanceScore: perfScore,
    reputationScore: repScore,
    combinedScore,
    canWork,
  };
}

export function getAllPeerScores(state: PeerTrackerState): PeerScore[] {
  const peerIds = new Set<string>();

  for (const peerId of state.performance.metrics.keys()) {
    peerIds.add(peerId);
  }

  if (state.reputation) {
    for (const peerId of state.reputation.peers.keys()) {
      peerIds.add(peerId);
    }
  }

  const scores: PeerScore[] = [];
  for (const peerId of peerIds) {
    const score = getPeerScore(state, peerId);
    if (score) {
      scores.push(score);
    }
  }

  return scores.sort((a, b) => {
    const scoreDiff = b.combinedScore - a.combinedScore;
    if (scoreDiff !== 0) return scoreDiff;
    return a.peerId.localeCompare(b.peerId);
  });
}

export function getTopPeers(state: PeerTrackerState, limit: number): PeerScore[] {
  return getAllPeerScores(state).slice(0, limit);
}

export function getStakedPeers(state: PeerTrackerState): PeerScore[] {
  return getAllPeerScores(state).filter((p) => p.canWork);
}

export async function syncPeerReputation(
  state: PeerTrackerState,
  peerId: string,
  walletAddress: `0x${string}`
): Promise<void> {
  if (!state.reputation || !state.wallet) {
    return;
  }

  await syncPeerFromChain(state.reputation, state.wallet, peerId, walletAddress);
}

export async function commitRatings(state: PeerTrackerState): Promise<{ committed: number; failed: number }> {
  if (!state.reputation || !state.wallet) {
    return { committed: 0, failed: 0 };
  }

  return commitPendingRatings(state.reputation, state.wallet);
}

export function getPendingRatingsCount(state: PeerTrackerState): number {
  if (!state.reputation) {
    return 0;
  }

  return state.reputation.pendingCommits.filter((r) => !r.recorded).length;
}
