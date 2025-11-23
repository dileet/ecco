import { Effect, Ref } from 'effect';
import type { NodeState } from './types';
import type {
  PeerInfo,
  PaymentLedgerEntry,
  StreamingAgreement,
  EscrowAgreement,
  StakePosition,
  SwarmSplit,
  SettlementIntent,
} from '../types';
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

export const addPaymentLedgerEntryRef = (
  stateRef: Ref.Ref<NodeState>,
  entry: PaymentLedgerEntry
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    paymentLedger: new Map(state.paymentLedger).set(entry.id, entry),
  }));

export const updatePaymentLedgerEntryRef = (
  stateRef: Ref.Ref<NodeState>,
  entryId: string,
  updater: (entry: PaymentLedgerEntry) => PaymentLedgerEntry
): Effect.Effect<void> =>
  updateState(stateRef, (state) => {
    const entry = state.paymentLedger.get(entryId);
    if (!entry) {
      return state;
    }
    const newLedger = new Map(state.paymentLedger);
    newLedger.set(entryId, updater(entry));
    return { ...state, paymentLedger: newLedger };
  });

export const setStreamingChannelRef = (
  stateRef: Ref.Ref<NodeState>,
  channel: StreamingAgreement
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    streamingChannels: new Map(state.streamingChannels).set(channel.id, channel),
  }));

export const updateStreamingChannelRef = (
  stateRef: Ref.Ref<NodeState>,
  channelId: string,
  updater: (channel: StreamingAgreement) => StreamingAgreement
): Effect.Effect<void> =>
  updateState(stateRef, (state) => {
    const channel = state.streamingChannels.get(channelId);
    if (!channel) {
      return state;
    }
    const newChannels = new Map(state.streamingChannels);
    newChannels.set(channelId, updater(channel));
    return { ...state, streamingChannels: newChannels };
  });

export const setEscrowAgreementRef = (
  stateRef: Ref.Ref<NodeState>,
  agreement: EscrowAgreement
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    escrowAgreements: new Map(state.escrowAgreements).set(agreement.id, agreement),
  }));

export const updateEscrowAgreementRef = (
  stateRef: Ref.Ref<NodeState>,
  agreementId: string,
  updater: (agreement: EscrowAgreement) => EscrowAgreement
): Effect.Effect<void> =>
  updateState(stateRef, (state) => {
    const agreement = state.escrowAgreements.get(agreementId);
    if (!agreement) {
      return state;
    }
    const newAgreements = new Map(state.escrowAgreements);
    newAgreements.set(agreementId, updater(agreement));
    return { ...state, escrowAgreements: newAgreements };
  });

export const setStakePositionRef = (
  stateRef: Ref.Ref<NodeState>,
  position: StakePosition
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    stakePositions: new Map(state.stakePositions).set(position.id, position),
  }));

export const updateStakePositionRef = (
  stateRef: Ref.Ref<NodeState>,
  positionId: string,
  updater: (position: StakePosition) => StakePosition
): Effect.Effect<void> =>
  updateState(stateRef, (state) => {
    const position = state.stakePositions.get(positionId);
    if (!position) {
      return state;
    }
    const newPositions = new Map(state.stakePositions);
    newPositions.set(positionId, updater(position));
    return { ...state, stakePositions: newPositions };
  });

export const setSwarmSplitRef = (
  stateRef: Ref.Ref<NodeState>,
  split: SwarmSplit
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    swarmSplits: new Map(state.swarmSplits).set(split.id, split),
  }));

export const updateSwarmSplitRef = (
  stateRef: Ref.Ref<NodeState>,
  splitId: string,
  updater: (split: SwarmSplit) => SwarmSplit
): Effect.Effect<void> =>
  updateState(stateRef, (state) => {
    const split = state.swarmSplits.get(splitId);
    if (!split) {
      return state;
    }
    const newSplits = new Map(state.swarmSplits);
    newSplits.set(splitId, updater(split));
    return { ...state, swarmSplits: newSplits };
  });

export const enqueueSettlementRef = (
  stateRef: Ref.Ref<NodeState>,
  intent: SettlementIntent
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    pendingSettlements: [...state.pendingSettlements, intent],
  }));

export const dequeueSettlementRef = (
  stateRef: Ref.Ref<NodeState>
): Effect.Effect<SettlementIntent | undefined> =>
  modifyState(stateRef, (state) => {
    if (state.pendingSettlements.length === 0) {
      return [undefined, state] as const;
    }
    const [first, ...rest] = state.pendingSettlements;
    return [first, { ...state, pendingSettlements: rest }] as const;
  });

export const removeSettlementRef = (
  stateRef: Ref.Ref<NodeState>,
  intentId: string
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    pendingSettlements: state.pendingSettlements.filter((intent) => intent.id !== intentId),
  }));

export const updateSettlementRef = (
  stateRef: Ref.Ref<NodeState>,
  intentId: string,
  updater: (intent: SettlementIntent) => SettlementIntent
): Effect.Effect<void> =>
  updateState(stateRef, (state) => ({
    ...state,
    pendingSettlements: state.pendingSettlements.map((intent) =>
      intent.id === intentId ? updater(intent) : intent
    ),
  }));

export async function setStreamingChannel(
  stateRef: Ref.Ref<NodeState>,
  channel: StreamingAgreement
): Promise<void> {
  return await Effect.runPromise(setStreamingChannelRef(stateRef, channel));
}

export async function updateStreamingChannel(
  stateRef: Ref.Ref<NodeState>,
  channelId: string,
  updater: (channel: StreamingAgreement) => StreamingAgreement
): Promise<void> {
  return await Effect.runPromise(updateStreamingChannelRef(stateRef, channelId, updater));
}

export async function setEscrowAgreement(
  stateRef: Ref.Ref<NodeState>,
  agreement: EscrowAgreement
): Promise<void> {
  return await Effect.runPromise(setEscrowAgreementRef(stateRef, agreement));
}

export async function updateEscrowAgreement(
  stateRef: Ref.Ref<NodeState>,
  agreementId: string,
  updater: (agreement: EscrowAgreement) => EscrowAgreement
): Promise<void> {
  return await Effect.runPromise(updateEscrowAgreementRef(stateRef, agreementId, updater));
}

export async function setSwarmSplit(
  stateRef: Ref.Ref<NodeState>,
  split: SwarmSplit
): Promise<void> {
  return await Effect.runPromise(setSwarmSplitRef(stateRef, split));
}

export async function updateSwarmSplit(
  stateRef: Ref.Ref<NodeState>,
  splitId: string,
  updater: (split: SwarmSplit) => SwarmSplit
): Promise<void> {
  return await Effect.runPromise(updateSwarmSplitRef(stateRef, splitId, updater));
}

export async function addPaymentLedgerEntry(
  stateRef: Ref.Ref<NodeState>,
  entry: PaymentLedgerEntry
): Promise<void> {
  return await Effect.runPromise(addPaymentLedgerEntryRef(stateRef, entry));
}

export async function enqueueSettlement(
  stateRef: Ref.Ref<NodeState>,
  intent: SettlementIntent
): Promise<void> {
  return await Effect.runPromise(enqueueSettlementRef(stateRef, intent));
}

export async function getNodeState(stateRef: Ref.Ref<NodeState>): Promise<NodeState> {
  return await Effect.runPromise(getState(stateRef));
}
