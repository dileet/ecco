import { Effect, Ref } from 'effect';
import type { NodeState } from './types';
import { createPeerPerformanceState } from './peer-performance';
import { createBadBehaviorTracker } from './bad-behavior-sketch';

export const setupPerformanceTracking = (
  stateRef: Ref.Ref<NodeState>
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);

    if (state.performanceTracker && state.badBehaviorTracker) {
      return;
    }

    const performanceTracker = yield* createPeerPerformanceState({
      maxPeers: 50000,
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      windowSize: 100,
    });

    const badBehaviorTracker = yield* createBadBehaviorTracker({
      width: 10000,
      depth: 4,
      threshold: 5,
    });

    yield* Ref.set(stateRef, {
      ...state,
      performanceTracker,
      badBehaviorTracker,
    });
  });
