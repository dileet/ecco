export type PeerMetrics = {
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
};

export type PeerPerformanceState = {
  metrics: Map<string, PeerMetrics>;
  maxPeers: number;
  ttlMs: number;
  windowSize: number;
};

const evictStaleEntries = (state: PeerPerformanceState): void => {
  const now = Date.now();
  const staleThreshold = now - state.ttlMs;

  for (const [peerId, metrics] of state.metrics.entries()) {
    if (metrics.lastAccessed <= staleThreshold) {
      state.metrics.delete(peerId);
    }
  }
};

// Removes least recently accessed peers when capacity exceeds maxPeers
const evictLRU = (state: PeerPerformanceState): void => {
  if (state.metrics.size <= state.maxPeers) {
    return;
  }

  const entries = Array.from(state.metrics.entries());
  entries.sort((a, b) => b[1].lastAccessed - a[1].lastAccessed);

  state.metrics.clear();
  for (const [peerId, metrics] of entries.slice(0, state.maxPeers)) {
    state.metrics.set(peerId, metrics);
  }
};

// Adds a value to the array, dropping the oldest if it exceeds maxSize
const addToWindow = <T>(window: T[], value: T, maxSize: number): T[] => {
  const newWindow = [...window, value];
  if (newWindow.length > maxSize) {
    return newWindow.slice(-maxSize);
  }
  return newWindow;
};

export const recordSuccess = (
  state: PeerPerformanceState,
  peerId: string,
  latencyMs: number,
  throughput?: number
): void => {
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
        recentThroughput:
          throughput !== undefined
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

  state.metrics.set(peerId, updated);
  evictStaleEntries(state);
  evictLRU(state);
};

export const recordFailure = (
  state: PeerPerformanceState,
  peerId: string,
  errorCode?: number
): void => {
  const now = Date.now();
  const existing = state.metrics.get(peerId);

  const updated: PeerMetrics = existing
    ? {
        ...existing,
        failureCount: existing.failureCount + 1,
        requestCount: existing.requestCount + 1,
        lastUpdated: now,
        lastAccessed: now,
        recentErrors:
          errorCode !== undefined
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

  state.metrics.set(peerId, updated);
  evictStaleEntries(state);
  evictLRU(state);
};

export const getMetrics = (state: PeerPerformanceState, peerId: string): PeerMetrics | undefined => {
  const metrics = state.metrics.get(peerId);

  if (metrics) {
    const now = Date.now();
    const updatedMetrics = { ...metrics, lastAccessed: now };
    state.metrics.set(peerId, updatedMetrics);
    return updatedMetrics;
  }

  return undefined;
};

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

  return successWeight * successRate + errorWeight * (1 - recentErrorRate) + latencyWeight * latencyScore;
};

export const getAllMetrics = (state: PeerPerformanceState): Map<string, PeerMetrics> => {
  return new Map(state.metrics);
};

export const clearMetrics = (state: PeerPerformanceState): void => {
  state.metrics.clear();
};
