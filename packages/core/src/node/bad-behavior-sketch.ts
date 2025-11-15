import { Effect, Ref } from 'effect';

export interface CountMinSketchState {
  width: number;
  depth: number;
  counters: number[][];
  seeds: number[];
}

export interface BadBehaviorConfig {
  width?: number;
  depth?: number;
  threshold?: number;
}

const DEFAULT_CONFIG = {
  width: 10000,
  depth: 4,
  threshold: 5,
};

const hash = (str: string, seed: number, width: number): number => {
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff;
  }
  return h % width;
};

export const createCountMinSketch = (
  config: BadBehaviorConfig = {}
): Effect.Effect<Ref.Ref<CountMinSketchState>> => {
  const width = config.width ?? DEFAULT_CONFIG.width;
  const depth = config.depth ?? DEFAULT_CONFIG.depth;

  const counters: number[][] = [];
  const seeds: number[] = [];

  for (let i = 0; i < depth; i++) {
    counters.push(new Array(width).fill(0));
    seeds.push(Math.floor(Math.random() * 0x7fffffff));
  }

  return Ref.make<CountMinSketchState>({
    width,
    depth,
    counters,
    seeds,
  });
};

export const incrementBadBehavior = (
  stateRef: Ref.Ref<CountMinSketchState>,
  peerId: string,
  count: number = 1
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);

    const newCounters = state.counters.map((row, i) => {
      const idx = hash(peerId, state.seeds[i], state.width);
      const newRow = [...row];
      newRow[idx] += count;
      return newRow;
    });

    yield* Ref.set(stateRef, { ...state, counters: newCounters });
  });

export const queryBadBehavior = (
  stateRef: Ref.Ref<CountMinSketchState>,
  peerId: string
): Effect.Effect<number> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);

    let minCount = Infinity;
    for (let i = 0; i < state.depth; i++) {
      const idx = hash(peerId, state.seeds[i], state.width);
      const count = state.counters[i][idx];
      minCount = Math.min(minCount, count);
    }

    return minCount === Infinity ? 0 : minCount;
  });

export const isBadPeer = (
  stateRef: Ref.Ref<CountMinSketchState>,
  peerId: string,
  threshold: number = DEFAULT_CONFIG.threshold
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const count = yield* queryBadBehavior(stateRef, peerId);
    return count >= threshold;
  });

export const clearSketch = (
  stateRef: Ref.Ref<CountMinSketchState>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const newCounters = state.counters.map((row) => new Array(state.width).fill(0));
    yield* Ref.set(stateRef, { ...state, counters: newCounters });
  });

export interface BadBehaviorTracker {
  sketch: Ref.Ref<CountMinSketchState>;
  threshold: number;
}

export const createBadBehaviorTracker = (
  config: BadBehaviorConfig = {}
): Effect.Effect<BadBehaviorTracker> =>
  Effect.gen(function* () {
    const sketch = yield* createCountMinSketch(config);
    return {
      sketch,
      threshold: config.threshold ?? DEFAULT_CONFIG.threshold,
    };
  });

export const recordMisbehavior = (
  tracker: BadBehaviorTracker,
  peerId: string,
  severity: number = 1
): Effect.Effect<void> => incrementBadBehavior(tracker.sketch, peerId, severity);

export const isBlockedPeer = (
  tracker: BadBehaviorTracker,
  peerId: string
): Effect.Effect<boolean> => isBadPeer(tracker.sketch, peerId, tracker.threshold);
