import { Effect, Ref } from 'effect';
import type { NodeState } from './types';
import type { PeerInfo } from '../types';
import type { BreakerState } from '../util/circuit-breaker';
import type { RegistryClientState } from '../services';
import type { WalletState } from '../services/wallet';
import type { AuthState } from '../auth';
import type { PoolState } from '../connection';

export const makeStateRef = (
  initialState: NodeState
): Effect.Effect<Ref.Ref<NodeState>> =>
  Ref.make(initialState);

export const getState = (
  stateRef: Ref.Ref<NodeState>
): Effect.Effect<NodeState> =>
  Ref.get(stateRef);

export const updateState = (
  stateRef: Ref.Ref<NodeState>,
  updater: (state: NodeState) => NodeState
): Effect.Effect<void> =>
  Ref.update(stateRef, updater);

export const setState = (
  stateRef: Ref.Ref<NodeState>,
  newState: NodeState
): Effect.Effect<void> =>
  Ref.set(stateRef, newState);

export const modifyState = <A>(
  stateRef: Ref.Ref<NodeState>,
  f: (state: NodeState) => readonly [A, NodeState]
): Effect.Effect<A> =>
  Ref.modify(stateRef, f);

export const addPeerRef = (
  stateRef: Ref.Ref<NodeState>,
  peer: PeerInfo
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    peers: new Map(state.peers).set(peer.id, peer),
  }));

export const removePeerRef = (
  stateRef: Ref.Ref<NodeState>,
  peerId: string
): Effect.Effect<void> =>
  updateState(stateRef, (state) => {
    const newPeers = new Map(state.peers);
    newPeers.delete(peerId);
    return { ...state, peers: newPeers };
  });

export const setCircuitBreakerRef = (
  stateRef: Ref.Ref<NodeState>,
  peerId: string,
  breaker: BreakerState
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    circuitBreakers: new Map(state.circuitBreakers).set(peerId, breaker),
  }));

export const getOrCreateCircuitBreaker = (
  stateRef: Ref.Ref<NodeState>,
  peerId: string,
  defaultBreaker: () => BreakerState
): Effect.Effect<BreakerState> =>
  modifyState(stateRef, (state) => {
    const existing = state.circuitBreakers.get(peerId);
    if (existing) {
      return [existing, state] as const;
    }
    const newBreaker = defaultBreaker();
    return [
      newBreaker,
      {
        ...state,
        circuitBreakers: new Map(state.circuitBreakers).set(peerId, newBreaker),
      },
    ] as const;
  });

export const setRegistryClientRef = (
  stateRef: Ref.Ref<NodeState>,
  clientRef: Ref.Ref<RegistryClientState>
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    registryClientRef: clientRef,
  }));

export const setMessageAuthRef = (
  stateRef: Ref.Ref<NodeState>,
  auth: AuthState
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    messageAuth: auth,
  }));

export const setConnectionPoolRef = (
  stateRef: Ref.Ref<NodeState>,
  pool: PoolState
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    connectionPool: pool,
  }));

export const setNodeRef = (
  stateRef: Ref.Ref<NodeState>,
  node: NodeState['node']
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    node,
  }));

export const setCapabilityTrackingSetupRef = (
  stateRef: Ref.Ref<NodeState>,
  setup: boolean
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    capabilityTrackingSetup: setup,
  }));

export const addPeersRef = (
  stateRef: Ref.Ref<NodeState>,
  peers: PeerInfo[]
): Effect.Effect<void> =>
  updateState(stateRef, (state) => {
    const newPeers = new Map(state.peers);
    for (const peer of peers) {
      newPeers.set(peer.id, peer);
    }
    return { ...state, peers: newPeers };
  });

export const subscribeToTopicRef = (
  stateRef: Ref.Ref<NodeState>,
  topic: string,
  handler: (event: any) => void
): Effect.Effect<void> =>
  updateState(stateRef, (state) => {
    const newSubscriptions = new Map(state.subscriptions);
    const handlers = newSubscriptions.get(topic) || new Set();
    handlers.add(handler);
    newSubscriptions.set(topic, handlers);
    return { ...state, subscriptions: newSubscriptions };
  });

export const setWalletRef = (
  stateRef: Ref.Ref<NodeState>,
  walletRef: Ref.Ref<WalletState>
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    walletRef,
  }));

export const getWalletRef = (
  stateRef: Ref.Ref<NodeState>
): Effect.Effect<Ref.Ref<WalletState> | undefined> =>
  Effect.gen(function* () {
    const state = yield* getState(stateRef);
    return state.walletRef;
  });
