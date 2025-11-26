import type { NodeState } from './types';
import type { PeerPerformanceState } from './peer-performance';

export const setupPerformanceTracking = (state: NodeState): NodeState => {
  if (state.performanceTracker) {
    return state;
  }

  const performanceTracker: PeerPerformanceState = {
    metrics: new Map(),
    maxPeers: 50000,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    windowSize: 100,
  };

  return {
    ...state,
    performanceTracker,
  };
};
