export type CountMinSketchState = {
  width: number;
  depth: number;
  counters: number[][];
  seeds: number[];
};

export type BadBehaviorTracker = {
  sketch: CountMinSketchState;
  threshold: number;
};

const hash = (str: string, seed: number, width: number): number => {
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff;
  }
  return h % width;
};

export const incrementBadBehavior = (state: CountMinSketchState, peerId: string, count: number = 1): void => {
  for (let i = 0; i < state.depth; i++) {
    const idx = hash(peerId, state.seeds[i], state.width);
    state.counters[i][idx] += count;
  }
};

export const queryBadBehavior = (state: CountMinSketchState, peerId: string): number => {
  let minCount = Infinity;
  for (let i = 0; i < state.depth; i++) {
    const idx = hash(peerId, state.seeds[i], state.width);
    const count = state.counters[i][idx];
    minCount = Math.min(minCount, count);
  }
  return minCount === Infinity ? 0 : minCount;
};

export const isBadPeer = (state: CountMinSketchState, peerId: string, threshold: number = 5): boolean => {
  const count = queryBadBehavior(state, peerId);
  return count >= threshold;
};

export const clearSketch = (state: CountMinSketchState): void => {
  for (let i = 0; i < state.depth; i++) {
    state.counters[i].fill(0);
  }
};

export const recordMisbehavior = (tracker: BadBehaviorTracker, peerId: string, severity: number = 1): void => {
  incrementBadBehavior(tracker.sketch, peerId, severity);
};

export const isBlockedPeer = (tracker: BadBehaviorTracker, peerId: string): boolean => {
  return isBadPeer(tracker.sketch, peerId, tracker.threshold);
};
