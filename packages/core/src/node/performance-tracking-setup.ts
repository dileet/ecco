import type { NodeState } from './types';
import type { PeerPerformanceState } from './peer-performance';
import type { BadBehaviorTracker, CountMinSketchState } from './bad-behavior-sketch';

export const setupPerformanceTracking = (state: NodeState): NodeState => {
  if (state.performanceTracker && state.badBehaviorTracker) {
    return state;
  }

  const performanceTracker: PeerPerformanceState = {
    metrics: new Map(),
    maxPeers: 50000,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    windowSize: 100,
  };

  const width = 10000;
  const depth = 4;
  const seeds: number[] = [];
  const counters: number[][] = [];
  for (let i = 0; i < depth; i++) {
    counters.push(new Array(width).fill(0));
    seeds.push(Math.floor(Math.random() * 0x7fffffff));
  }

  const sketch: CountMinSketchState = {
    width,
    depth,
    counters,
    seeds,
  };

  const badBehaviorTracker: BadBehaviorTracker = {
    sketch,
    threshold: 5,
  };

  return {
    ...state,
    performanceTracker,
    badBehaviorTracker,
  };
};
