import { nanoid } from 'nanoid';
import type { NodeState, StateRef, EventHandler } from './types';
import type {
  PeerInfo,
  PaymentLedgerEntry,
  StreamingAgreement,
  EscrowAgreement,
  StakePosition,
  SwarmSplit,
  SettlementIntent,
  EccoConfig,
} from '../types';
import type { ClientState as RegistryClientState } from '../registry-client';
import type { WalletState } from '../services/wallet';
import type { AuthState } from '../services/auth';
import { Pool, type PoolState } from '../connection';
import { configDefaults, mergeConfig } from '../config';
import * as storage from '../storage';

export type { StateRef } from './types';

export const createStateRef = <T>(initial: T): StateRef<T> => ({ current: initial });

export const createInitialState = (config: EccoConfig): NodeState => {
  const fullConfig = mergeConfig(configDefaults, config);

  return {
    id: fullConfig.nodeId || nanoid(),
    config: fullConfig,
    node: null,
    capabilities: fullConfig.capabilities || [],
    peers: {},
    subscriptions: {},
    capabilityTrackingSetup: false,
    paymentLedger: {},
    streamingChannels: {},
    escrowAgreements: {},
    stakePositions: {},
    swarmSplits: {},
    pendingSettlements: [],
    ...(fullConfig.connectionPool ? { connectionPool: Pool.createState(fullConfig.connectionPool) } : {}),
  };
};

export const getState = <T>(ref: StateRef<T>): T => ref.current;

export const setState = <T>(ref: StateRef<T>, value: T): void => {
  ref.current = value;
};

export const updateState = <T>(ref: StateRef<T>, fn: (state: T) => T): void => {
  ref.current = fn(ref.current);
};

export const modifyState = <T, A>(ref: StateRef<T>, fn: (state: T) => readonly [A, T]): A => {
  const [result, newState] = fn(ref.current);
  ref.current = newState;
  return result;
};

export const addPeer = (state: NodeState, peer: PeerInfo): NodeState => ({
  ...state,
  peers: { ...state.peers, [peer.id]: peer },
});

export const removePeer = (state: NodeState, peerId: string): NodeState => {
  const { [peerId]: _, ...remainingPeers } = state.peers;
  return { ...state, peers: remainingPeers };
};

export const updatePeer = (state: NodeState, peerId: string, updates: Partial<PeerInfo>): NodeState => {
  const existing = state.peers[peerId];
  if (!existing) return state;
  return {
    ...state,
    peers: { ...state.peers, [peerId]: { ...existing, ...updates } },
  };
};

export const addPeers = (state: NodeState, peers: PeerInfo[]): NodeState => {
  const newPeers = peers.reduce(
    (acc, peer) => ({ ...acc, [peer.id]: peer }),
    state.peers
  );
  return { ...state, peers: newPeers };
};

export const addSubscription = (
  state: NodeState,
  topic: string,
  handler: EventHandler
): NodeState => {
  const existingHandlers = state.subscriptions[topic] || [];
  return {
    ...state,
    subscriptions: {
      ...state.subscriptions,
      [topic]: [...existingHandlers, handler],
    },
  };
};

export const setRegistryClient = (state: NodeState, client: RegistryClientState): NodeState => ({
  ...state,
  registryClient: client,
});

export const setMessageAuth = (state: NodeState, auth: AuthState): NodeState => ({
  ...state,
  messageAuth: auth,
});

export const setConnectionPool = (state: NodeState, pool: PoolState): NodeState => ({
  ...state,
  connectionPool: pool,
});

export const setNode = (state: NodeState, node: NodeState['node']): NodeState => ({
  ...state,
  node,
});

export const setCapabilityTrackingSetup = (state: NodeState, setup: boolean): NodeState => ({
  ...state,
  capabilityTrackingSetup: setup,
});

export const setWallet = (state: NodeState, wallet: WalletState): NodeState => ({
  ...state,
  wallet,
});

export const getWallet = (state: NodeState): WalletState | undefined => state.wallet;

export const addPaymentLedgerEntry = async (
  state: NodeState,
  entry: PaymentLedgerEntry
): Promise<NodeState> => {
  await storage.writePaymentLedgerEntry(entry);
  return {
    ...state,
    paymentLedger: { ...state.paymentLedger, [entry.id]: entry },
  };
};

export const updatePaymentLedgerEntry = async (
  state: NodeState,
  entryId: string,
  updater: (entry: PaymentLedgerEntry) => PaymentLedgerEntry
): Promise<NodeState> => {
  const entry = state.paymentLedger[entryId];
  if (!entry) return state;

  const updatedEntry = updater(entry);
  await storage.updatePaymentLedgerEntry(updatedEntry);

  return {
    ...state,
    paymentLedger: { ...state.paymentLedger, [entryId]: updatedEntry },
  };
};

export const setStreamingChannel = async (
  state: NodeState,
  channel: StreamingAgreement
): Promise<NodeState> => {
  await storage.writeStreamingChannel(channel);
  return {
    ...state,
    streamingChannels: { ...state.streamingChannels, [channel.id]: channel },
  };
};

export const updateStreamingChannel = async (
  state: NodeState,
  channelId: string,
  updater: (channel: StreamingAgreement) => StreamingAgreement
): Promise<NodeState> => {
  const channel = state.streamingChannels[channelId];
  if (!channel) return state;

  const updatedChannel = updater(channel);
  await storage.updateStreamingChannel(updatedChannel);

  return {
    ...state,
    streamingChannels: { ...state.streamingChannels, [channelId]: updatedChannel },
  };
};

export const setEscrowAgreement = async (
  state: NodeState,
  agreement: EscrowAgreement
): Promise<NodeState> => {
  await storage.writeEscrowAgreement(agreement);
  return {
    ...state,
    escrowAgreements: { ...state.escrowAgreements, [agreement.id]: agreement },
  };
};

export const updateEscrowAgreement = async (
  state: NodeState,
  agreementId: string,
  updater: (agreement: EscrowAgreement) => EscrowAgreement
): Promise<NodeState> => {
  const agreement = state.escrowAgreements[agreementId];
  if (!agreement) return state;

  const updatedAgreement = updater(agreement);
  await storage.updateEscrowAgreement(updatedAgreement);

  return {
    ...state,
    escrowAgreements: { ...state.escrowAgreements, [agreementId]: updatedAgreement },
  };
};

export const setStakePosition = async (
  state: NodeState,
  position: StakePosition
): Promise<NodeState> => {
  await storage.writeStakePosition(position);
  return {
    ...state,
    stakePositions: { ...state.stakePositions, [position.id]: position },
  };
};

export const updateStakePosition = async (
  state: NodeState,
  positionId: string,
  updater: (position: StakePosition) => StakePosition
): Promise<NodeState> => {
  const position = state.stakePositions[positionId];
  if (!position) return state;

  const updatedPosition = updater(position);
  await storage.updateStakePosition(updatedPosition);

  return {
    ...state,
    stakePositions: { ...state.stakePositions, [positionId]: updatedPosition },
  };
};

export const setSwarmSplit = async (
  state: NodeState,
  split: SwarmSplit
): Promise<NodeState> => {
  await storage.writeSwarmSplit(split);
  return {
    ...state,
    swarmSplits: { ...state.swarmSplits, [split.id]: split },
  };
};

export const updateSwarmSplit = async (
  state: NodeState,
  splitId: string,
  updater: (split: SwarmSplit) => SwarmSplit
): Promise<NodeState> => {
  const split = state.swarmSplits[splitId];
  if (!split) return state;

  const updatedSplit = updater(split);
  await storage.updateSwarmSplit(updatedSplit);

  return {
    ...state,
    swarmSplits: { ...state.swarmSplits, [splitId]: updatedSplit },
  };
};

export const enqueueSettlement = async (
  state: NodeState,
  intent: SettlementIntent
): Promise<NodeState> => {
  await storage.writeSettlement(intent);
  return {
    ...state,
    pendingSettlements: [...state.pendingSettlements, intent],
  };
};

export const dequeueSettlement = async (
  state: NodeState
): Promise<{ settlement: SettlementIntent | undefined; state: NodeState }> => {
  if (state.pendingSettlements.length === 0) {
    return { settlement: undefined, state };
  }

  const [first, ...rest] = state.pendingSettlements;
  await storage.removeSettlement(first.id);

  return {
    settlement: first,
    state: { ...state, pendingSettlements: rest },
  };
};

export const removeSettlement = async (
  state: NodeState,
  intentId: string
): Promise<NodeState> => {
  await storage.removeSettlement(intentId);
  return {
    ...state,
    pendingSettlements: state.pendingSettlements.filter((intent) => intent.id !== intentId),
  };
};

export const updateSettlement = async (
  state: NodeState,
  intentId: string,
  updater: (intent: SettlementIntent) => SettlementIntent
): Promise<NodeState> => {
  const intent = state.pendingSettlements.find((i) => i.id === intentId);
  if (!intent) return state;

  const updatedIntent = updater(intent);
  await storage.updateSettlement(updatedIntent);

  return {
    ...state,
    pendingSettlements: state.pendingSettlements.map((i) =>
      i.id === intentId ? updatedIntent : i
    ),
  };
};
