import { Effect, Ref } from 'effect';

export interface PeerMetrics {
  peerId: string;
  successCount: number;
  failureCount: number;
  totalLatency: number;
  requestCount: number;
  lastUpdated: number;
  lastAccessed: number;
  recentErrors: number[];
  recentLatencies: number[];
  recentThroughput: number[];
}

export interface PeerPerformanceState {
  metrics: Map<string, PeerMetrics>;
  maxPeers: number;
  ttlMs: number;
  windowSize: number;
}

export interface PeerPerformanceConfig {
  maxPeers?: number;
  ttlMs?: number;
  windowSize?: number;
}

const DEFAULT_CONFIG = {
  maxPeers: 50000,
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  windowSize: 100,
};

export const createPeerPerformanceState = (
  config: PeerPerformanceConfig = {}
): Effect.Effect<Ref.Ref<PeerPerformanceState>> => {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  return Ref.make<PeerPerformanceState>({
    metrics: new Map(),
    maxPeers: finalConfig.maxPeers,
    ttlMs: finalConfig.ttlMs,
    windowSize: finalConfig.windowSize,
  });
};

const evictStaleEntries = (state: PeerPerformanceState): PeerPerformanceState => {
  const now = Date.now();
  const staleThreshold = now - state.ttlMs;

  const freshMetrics = new Map<string, PeerMetrics>();
  for (const [peerId, metrics] of state.metrics.entries()) {
    if (metrics.lastAccessed > staleThreshold) {
      freshMetrics.set(peerId, metrics);
    }
  }

  return { ...state, metrics: freshMetrics };
};

const evictLRU = (state: PeerPerformanceState): PeerPerformanceState => {
  if (state.metrics.size <= state.maxPeers) {
    return state;
  }

  const entries = Array.from(state.metrics.entries());
  entries.sort((a, b) => b[1].lastAccessed - a[1].lastAccessed);

  const kept = entries.slice(0, state.maxPeers);
  return { ...state, metrics: new Map(kept) };
};

const addToWindow = <T>(window: T[], value: T, maxSize: number): T[] => {
  const newWindow = [...window, value];
  if (newWindow.length > maxSize) {
    return newWindow.slice(-maxSize);
  }
  return newWindow;
};

export const recordSuccess = (
  stateRef: Ref.Ref<PeerPerformanceState>,
  peerId: string,
  latencyMs: number,
  throughput?: number
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const now = Date.now();

    const existing = state.metrics.get(peerId);
    const updated: PeerMetrics = existing
      ? {
          ...existing,
          successCount: existing.successCount + 1,
          requestCount: existing.requestCount + 1,
          totalLatency: existing.totalLatency + latencyMs,
          lastUpdated: now,
          lastAccessed: now,
          recentLatencies: addToWindow(existing.recentLatencies, latencyMs, state.windowSize),
          recentThroughput: throughput !== undefined
            ? addToWindow(existing.recentThroughput, throughput, state.windowSize)
            : existing.recentThroughput,
          recentErrors: existing.recentErrors,
        }
      : {
          peerId,
          successCount: 1,
          failureCount: 0,
          requestCount: 1,
          totalLatency: latencyMs,
          lastUpdated: now,
          lastAccessed: now,
          recentLatencies: [latencyMs],
          recentThroughput: throughput !== undefined ? [throughput] : [],
          recentErrors: [],
        };

    const newMetrics = new Map(state.metrics);
    newMetrics.set(peerId, updated);

    let newState = { ...state, metrics: newMetrics };
    newState = evictStaleEntries(newState);
    newState = evictLRU(newState);

    yield* Ref.set(stateRef, newState);
  });

export const recordFailure = (
  stateRef: Ref.Ref<PeerPerformanceState>,
  peerId: string,
  errorCode?: number
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const now = Date.now();

    const existing = state.metrics.get(peerId);
    const updated: PeerMetrics = existing
      ? {
          ...existing,
          failureCount: existing.failureCount + 1,
          requestCount: existing.requestCount + 1,
          lastUpdated: now,
          lastAccessed: now,
          recentErrors: errorCode !== undefined
            ? addToWindow(existing.recentErrors, errorCode, state.windowSize)
            : existing.recentErrors,
        }
      : {
          peerId,
          successCount: 0,
          failureCount: 1,
          requestCount: 1,
          totalLatency: 0,
          lastUpdated: now,
          lastAccessed: now,
          recentLatencies: [],
          recentThroughput: [],
          recentErrors: errorCode !== undefined ? [errorCode] : [],
        };

    const newMetrics = new Map(state.metrics);
    newMetrics.set(peerId, updated);

    let newState = { ...state, metrics: newMetrics };
    newState = evictStaleEntries(newState);
    newState = evictLRU(newState);

    yield* Ref.set(stateRef, newState);
  });

export const getMetrics = (
  stateRef: Ref.Ref<PeerPerformanceState>,
  peerId: string
): Effect.Effect<PeerMetrics | undefined> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const metrics = state.metrics.get(peerId);

    if (metrics) {
      const now = Date.now();
      const updatedMetrics = { ...metrics, lastAccessed: now };
      const newMetrics = new Map(state.metrics);
      newMetrics.set(peerId, updatedMetrics);
      yield* Ref.set(stateRef, { ...state, metrics: newMetrics });
      return updatedMetrics;
    }

    return undefined;
  });

export const calculateSuccessRate = (metrics: PeerMetrics): number => {
  if (metrics.requestCount === 0) return 0;
  return metrics.successCount / metrics.requestCount;
};

export const calculateAverageLatency = (metrics: PeerMetrics): number => {
  if (metrics.successCount === 0) return Infinity;
  return metrics.totalLatency / metrics.successCount;
};

export const calculateRecentAverageLatency = (metrics: PeerMetrics): number => {
  if (metrics.recentLatencies.length === 0) return Infinity;
  const sum = metrics.recentLatencies.reduce((acc, val) => acc + val, 0);
  return sum / metrics.recentLatencies.length;
};

export const calculateRecentErrorRate = (metrics: PeerMetrics): number => {
  const recentTotal = metrics.recentLatencies.length + metrics.recentErrors.length;
  if (recentTotal === 0) return 0;
  return metrics.recentErrors.length / recentTotal;
};

export const calculatePerformanceScore = (metrics: PeerMetrics): number => {
  const successRate = calculateSuccessRate(metrics);
  const recentErrorRate = calculateRecentErrorRate(metrics);
  const avgLatency = calculateRecentAverageLatency(metrics);

  const successWeight = 0.5;
  const errorWeight = 0.3;
  const latencyWeight = 0.2;

  const latencyScore = avgLatency === Infinity ? 0 : Math.max(0, 1 - avgLatency / 10000);

  return (
    successWeight * successRate +
    errorWeight * (1 - recentErrorRate) +
    latencyWeight * latencyScore
  );
};

export const getAllMetrics = (
  stateRef: Ref.Ref<PeerPerformanceState>
): Effect.Effect<Map<string, PeerMetrics>> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    return new Map(state.metrics);
  });

export const clearMetrics = (
  stateRef: Ref.Ref<PeerPerformanceState>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    yield* Ref.set(stateRef, { ...state, metrics: new Map() });
  });
