import type { NodeState, StateRef, EventHandler, CleanupHandler, MessageFloodProtection } from './types';
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
import type { WalletState } from '../services/wallet';
import type { AuthState } from '../services/auth';
import type { MessageBridgeState } from '../transport/message-bridge';
import { DEFAULT_CONFIG, type PoolState } from '../connection';
import { configDefaults, mergeConfig } from '../config';
import * as storage from '../storage';
import { createLRUCache, cloneLRUCache } from '../utils/lru-cache';
import { createMessageDeduplicator, createRateLimiter } from '../utils/bloom-filter';
import { spinBackoff } from '../utils/timing';
import { SDK_PROTOCOL_VERSION } from '../networks';

export type { StateRef } from './types';

const MAX_CAS_RETRIES = 100;
const CAS_BACKOFF_STEP_MS = 1;
const MAX_CAS_BACKOFF_MS = 10;
const DEFAULT_MAX_PEERS = 10000;
const DEFAULT_STALE_PEER_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_DEDUP_MAX_MESSAGES = 10000;
const DEFAULT_DEDUP_FALSE_POSITIVE_RATE = 0.01;
const DEFAULT_RATE_LIMIT_MAX_TOKENS = 100;
const DEFAULT_RATE_LIMIT_REFILL_RATE = 10;
const DEFAULT_RATE_LIMIT_REFILL_INTERVAL_MS = 1000;

const settlementQueues = new WeakMap<StateRef<NodeState>, Promise<void>>();

const withSettlementQueue = <T>(
  ref: StateRef<NodeState>,
  task: () => Promise<T>
): Promise<T> => {
  const current = settlementQueues.get(ref) ?? Promise.resolve();
  const next = current.then(task, task);
  settlementQueues.set(ref, next.then(() => undefined, () => undefined));
  return next;
};

export const createStateRef = <T>(initial: T): StateRef<T> => ({ 
  current: initial,
  version: 0,
});

export const createFloodProtection = (config: EccoConfig): MessageFloodProtection => {
  const dedupMaxMessages = config.floodProtection?.dedupMaxMessages ?? DEFAULT_DEDUP_MAX_MESSAGES;
  const dedupFalsePositiveRate = config.floodProtection?.dedupFalsePositiveRate ?? DEFAULT_DEDUP_FALSE_POSITIVE_RATE;
  const rateLimitMaxTokens = config.floodProtection?.rateLimitMaxTokens ?? DEFAULT_RATE_LIMIT_MAX_TOKENS;
  const rateLimitRefillRate = config.floodProtection?.rateLimitRefillRate ?? DEFAULT_RATE_LIMIT_REFILL_RATE;
  const rateLimitRefillIntervalMs = config.floodProtection?.rateLimitRefillIntervalMs ?? DEFAULT_RATE_LIMIT_REFILL_INTERVAL_MS;

  return {
    deduplicator: createMessageDeduplicator(dedupMaxMessages, dedupFalsePositiveRate),
    rateLimiter: createRateLimiter(rateLimitMaxTokens, rateLimitRefillRate, rateLimitRefillIntervalMs),
    topicSubscribers: new Map(),
  };
};

export const createInitialState = (config: EccoConfig): NodeState => {
  const fullConfig = mergeConfig(configDefaults, config);
  const maxPeers = fullConfig.memoryLimits?.maxPeers ?? DEFAULT_MAX_PEERS;

  return {
    id: fullConfig.nodeId || crypto.randomUUID(),
    shuttingDown: false,
    config: fullConfig,
    node: null,
    capabilities: fullConfig.capabilities || [],
    peers: createLRUCache<string, PeerInfo>(maxPeers),
    subscriptions: {},
    subscribedTopics: new Map(),
    cleanupHandlers: [],
    capabilityTrackingSetup: false,
    paymentLedger: {},
    streamingChannels: {},
    escrowAgreements: {},
    stakePositions: {},
    swarmSplits: {},
    pendingSettlements: [],
    floodProtection: createFloodProtection(fullConfig),
    protocolVersion: SDK_PROTOCOL_VERSION,
    versionValidatedPeers: new Set(),
    ...(fullConfig.connectionPool ? { connectionPool: {
      config: { ...DEFAULT_CONFIG, ...fullConfig.connectionPool },
      connections: new Map(),
      closed: false,
    }} : {}),
  };
};

export const getStalePeerTimeoutMs = (config: EccoConfig): number =>
  config.memoryLimits?.stalePeerTimeoutMs ?? DEFAULT_STALE_PEER_TIMEOUT_MS;

export const getState = <T>(ref: StateRef<T>): T => ref.current;

export const getVersion = <T>(ref: StateRef<T>): number => ref.version;

export const setState = <T>(ref: StateRef<T>, value: T): void => {
  ref.current = value;
  ref.version += 1;
};

export const updateState = <T>(ref: StateRef<T>, fn: (state: T) => T): void => {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    spinBackoff(attempt, CAS_BACKOFF_STEP_MS, MAX_CAS_BACKOFF_MS);
    const versionBefore = ref.version;
    const newState = fn(ref.current);
    if (ref.version === versionBefore) {
      ref.current = newState;
      ref.version = versionBefore + 1;
      return;
    }
  }
  throw new Error('updateState: exceeded max retries - concurrent state modification detected');
};

export const modifyState = <T, A>(ref: StateRef<T>, fn: (state: T) => readonly [A, T]): A => {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    spinBackoff(attempt, CAS_BACKOFF_STEP_MS, MAX_CAS_BACKOFF_MS);
    const versionBefore = ref.version;
    const [result, newState] = fn(ref.current);
    if (ref.version === versionBefore) {
      ref.current = newState;
      ref.version = versionBefore + 1;
      return result;
    }
  }
  throw new Error('modifyState: exceeded max retries - concurrent state modification detected');
};

export const addPeer = (state: NodeState, peer: PeerInfo): NodeState => {
  const newPeers = cloneLRUCache(state.peers);
  newPeers.set(peer.id, { ...peer, lastSeen: Date.now() });
  return { ...state, peers: newPeers };
};

export const removePeer = (state: NodeState, peerId: string): NodeState => {
  const newPeers = cloneLRUCache(state.peers);
  newPeers.delete(peerId);
  return { ...state, peers: newPeers };
};

export const updatePeer = (state: NodeState, peerId: string, updates: Partial<PeerInfo>): NodeState => {
  const existing = state.peers.get(peerId);
  if (!existing) return state;
  const newPeers = cloneLRUCache(state.peers);
  newPeers.set(peerId, { ...existing, ...updates, lastSeen: Date.now() });
  return { ...state, peers: newPeers };
};

export const addPeers = (state: NodeState, peers: PeerInfo[]): NodeState => {
  const newPeers = cloneLRUCache(state.peers);
  const now = Date.now();
  for (const peer of peers) {
    newPeers.set(peer.id, { ...peer, lastSeen: now });
  }
  return { ...state, peers: newPeers };
};

export const getPeer = (state: NodeState, peerId: string): PeerInfo | undefined =>
  state.peers.get(peerId);

export const hasPeer = (state: NodeState, peerId: string): boolean =>
  state.peers.has(peerId);

export const getAllPeers = (state: NodeState): PeerInfo[] =>
  state.peers.values();

export const getPeerCount = (state: NodeState): number =>
  state.peers.size;

export const evictStalePeers = (state: NodeState): NodeState => {
  const stalePeerTimeoutMs = getStalePeerTimeoutMs(state.config);
  const now = Date.now();
  const newPeers = cloneLRUCache(state.peers);
  
  for (const [peerId, peer] of state.peers.entries()) {
    if (now - peer.lastSeen > stalePeerTimeoutMs) {
      newPeers.delete(peerId);
    }
  }
  
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

export const removeSubscription = (
  state: NodeState,
  topic: string,
  handler: EventHandler
): NodeState => {
  const existingHandlers = state.subscriptions[topic];
  if (!existingHandlers) return state;

  const filteredHandlers = existingHandlers.filter((h) => h !== handler);

  if (filteredHandlers.length === 0) {
    const { [topic]: _, ...remainingSubscriptions } = state.subscriptions;
    return { ...state, subscriptions: remainingSubscriptions };
  }

  return {
    ...state,
    subscriptions: {
      ...state.subscriptions,
      [topic]: filteredHandlers,
    },
  };
};

export const registerCleanup = (ref: StateRef<NodeState>, handler: CleanupHandler): void => {
  updateState(ref, (state) => ({
    ...state,
    cleanupHandlers: [...state.cleanupHandlers, handler],
  }));
};

export const runCleanupHandlers = async (state: NodeState): Promise<void> => {
  for (const handler of state.cleanupHandlers) {
    try {
      await handler();
    } catch (error) {
      console.error('Cleanup handler error:', error);
    }
  }
};

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

export const setTransport = (state: NodeState, transport: NodeState['transport']): NodeState => ({
  ...state,
  transport,
});

export const getTransport = (state: NodeState): NodeState['transport'] => state.transport;

export const setMessageBridge = (state: NodeState, messageBridge: MessageBridgeState): NodeState => ({
  ...state,
  messageBridge,
});

export const getMessageBridge = (state: NodeState): MessageBridgeState | undefined => state.messageBridge;

export const getFloodProtection = (state: NodeState): MessageFloodProtection => state.floodProtection;

export const resetFloodProtection = (state: NodeState): NodeState => ({
  ...state,
  floodProtection: createFloodProtection(state.config),
});

export const clearRateLimits = (state: NodeState): void => {
  state.floodProtection.rateLimiter.clear();
};

export const resetPeerRateLimit = (state: NodeState, peerId: string): void => {
  state.floodProtection.rateLimiter.reset(peerId);
};

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
  ref: StateRef<NodeState>,
  intent: SettlementIntent
): Promise<NodeState> =>
  withSettlementQueue(ref, async () => {
    await storage.writeSettlement(intent);

    let nextState = getState(ref);

    updateState(ref, (state) => {
      const index = state.pendingSettlements.findIndex((entry) => entry.id === intent.id);
      if (index === -1) {
        const updated = { ...state, pendingSettlements: [...state.pendingSettlements, intent] };
        nextState = updated;
        return updated;
      }

      const updatedSettlements = [...state.pendingSettlements];
      updatedSettlements[index] = intent;
      const updated = { ...state, pendingSettlements: updatedSettlements };
      nextState = updated;
      return updated;
    });

    return nextState;
  });

export const dequeueSettlement = async (
  ref: StateRef<NodeState>
): Promise<{ settlement: SettlementIntent | undefined; state: NodeState }> =>
  withSettlementQueue(ref, async () => {
    const currentState = getState(ref);
    if (currentState.pendingSettlements.length === 0) {
      return { settlement: undefined, state: currentState };
    }

    const settlement = currentState.pendingSettlements[0];
    await storage.removeSettlement(settlement.id);

    let nextState = currentState;

    updateState(ref, (state) => {
      const updatedSettlements = state.pendingSettlements.filter((intent) => intent.id !== settlement.id);
      const updated = { ...state, pendingSettlements: updatedSettlements };
      nextState = updated;
      return updated;
    });

    return {
      settlement,
      state: nextState,
    };
  });

export const removeSettlement = async (
  ref: StateRef<NodeState>,
  intentId: string
): Promise<NodeState> =>
  withSettlementQueue(ref, async () => {
    await storage.removeSettlement(intentId);

    let nextState = getState(ref);

    updateState(ref, (state) => {
      const updatedSettlements = state.pendingSettlements.filter((intent) => intent.id !== intentId);
      const updated = { ...state, pendingSettlements: updatedSettlements };
      nextState = updated;
      return updated;
    });

    return nextState;
  });

export const updateSettlement = async (
  ref: StateRef<NodeState>,
  intentId: string,
  updater: (intent: SettlementIntent) => SettlementIntent
): Promise<NodeState> =>
  withSettlementQueue(ref, async () => {
    const currentState = getState(ref);
    const intent = currentState.pendingSettlements.find((i) => i.id === intentId);
    if (!intent) {
      return currentState;
    }

    const updatedIntent = updater(intent);
    await storage.updateSettlement(updatedIntent);

    let nextState = currentState;

    updateState(ref, (state) => {
      const updatedSettlements = state.pendingSettlements.map((i) =>
        i.id === intentId ? updatedIntent : i
      );
      const updated = { ...state, pendingSettlements: updatedSettlements };
      nextState = updated;
      return updated;
    });

    return nextState;
  });
