import type {
  Capability,
  CapabilityQuery,
  CapabilityMatch,
  Message,
  MessageType,
  EccoConfig,
} from '../types';
import { createInitialState as createInitialStateImpl, getState, setState } from './state';
import * as lifecycle from './lifecycle';
import { findPeers as findPeersImpl, findPeersWithPriority as findPeersWithPriorityImpl } from './discovery';
import type { NodeState, StateRef } from './types';
import type { EccoEvent } from '../events';
import { publish as publishFn, subscribeWithRef } from './messaging';
import { announceCapabilities } from './capabilities';
import { signMessage, verifyMessage, isMessageFresh, type AuthState, type SignedMessage } from '../services/auth';
import { getAddress, type WalletState } from '../services/wallet';
import { subscribeToAllDirectMessages } from '../transport/message-bridge';
import { debug } from '../utils';

export {
  createInitialState,
  createStateRef,
  getState,
  getVersion,
  setState,
  updateState,
  addPeer,
  removePeer,
  updatePeer,
  addPeers,
  getPeer,
  hasPeer,
  getAllPeers,
  getPeerCount,
  evictStalePeers,
  registerCleanup,
} from './state';
export type { StateRef } from './types';

export interface Agent {
  ref: StateRef<NodeState>;
  id: string;
  addrs: string[];
  auth: AuthState;
  wallet: WalletState | null;
  address: string | null;
  signAndSend: (peerId: string, message: Message) => Promise<void>;
}

export interface MessageContext {
  agent: Agent;
  reply: (payload: unknown, type?: MessageType) => Promise<void>;
}

export interface AgentCallbacks {
  onMessage?: (message: Message, ctx: MessageContext) => void | Promise<void>;
  onUnverifiedMessage?: (message: Message) => void | Promise<void>;
}

export interface EccoNode {
  ref: StateRef<NodeState>;
  id: string;
  addrs: string[];
}

export async function createAgent(config: EccoConfig, callbacks?: AgentCallbacks): Promise<Agent> {
  const state = createInitialStateImpl(config);
  const ref = await lifecycle.start(state);
  const nodeState = getState(ref);
  const libp2pPeerId = nodeState.node?.peerId?.toString();
  const id = libp2pPeerId ?? nodeState.id;
  const addrs = nodeState.node ? nodeState.node.getMultiaddrs().map(String) : [];

  const authState: AuthState = nodeState.messageAuth ?? {
    config: { enabled: false },
    keyCache: new Map(),
  };

  const walletState = nodeState.wallet ?? null;
  const walletAddress = walletState ? getAddress(walletState) : null;

  const signAndSend = async (peerId: string, message: Message): Promise<void> => {
    let messageToSend = message;
    if (authState.config.enabled) {
      messageToSend = await signMessage(authState, message);
    }
    await lifecycle.sendMessage(ref, peerId, messageToSend);
  };

  const agent: Agent = {
    ref,
    id,
    addrs,
    auth: authState,
    wallet: walletState,
    address: walletAddress,
    signAndSend,
  };

  if (callbacks?.onMessage || callbacks?.onUnverifiedMessage) {
    const wrappedHandler = async (message: Message): Promise<void> => {
      const currentNodeState = getState(ref);
      if (currentNodeState.shuttingDown) {
        return;
      }
      if (message.from === currentNodeState.libp2pPeerId || message.from === currentNodeState.id) {
        return;
      }

      const authEnabled = authState.config.enabled;

      if (message.signature && message.publicKey) {
        const { valid } = await verifyMessage(authState, message as SignedMessage);
        if (!valid) {
          console.warn(`[${id}] Rejected message with invalid signature from ${message.from}`);
          if (callbacks.onUnverifiedMessage) {
            await callbacks.onUnverifiedMessage(message);
          }
          return;
        }
        if (!isMessageFresh(message)) {
          console.warn(`[${id}] Rejected stale message from ${message.from}`);
          if (callbacks.onUnverifiedMessage) {
            await callbacks.onUnverifiedMessage(message);
          }
          return;
        }
      } else if (authEnabled) {
        console.warn(`[${id}] Received unsigned message from ${message.from}`);
        if (callbacks.onUnverifiedMessage) {
          await callbacks.onUnverifiedMessage(message);
        }
        return;
      }

      if (callbacks.onMessage) {
        const ctx: MessageContext = {
          agent,
          reply: async (payload: unknown, type: MessageType = 'agent-response') => {
            const currentState = getState(ref);
            if (currentState.shuttingDown) {
              return;
            }

            const targetPeerId = message.from;
            const selfPeerId = currentState.libp2pPeerId ?? currentState.node?.peerId?.toString();
            if (targetPeerId === selfPeerId || targetPeerId === currentState.id) {
              debug('reply', `Skipping reply to self (${targetPeerId})`);
              return;
            }

            const replyMessage: Message = {
              id: crypto.randomUUID(),
              from: id,
              to: targetPeerId,
              type,
              payload,
              timestamp: Date.now(),
            };
            debug('reply', `Sending reply from=${id} to=${targetPeerId} type=${type}`);
            debug('reply', `Payload requestId=${(payload as { requestId?: string })?.requestId}`);
            await agent.signAndSend(targetPeerId, replyMessage);
            debug('reply', 'Reply sent successfully');
          },
        };

        await callbacks.onMessage(message, ctx);
      }
    };

    const messageHandler = (event: EccoEvent): void => {
      if (event.type === 'message') {
        wrappedHandler(event.payload as Message).catch((err) => {
          console.error(`[${id}] Error handling message:`, err);
        });
      }
    };

    const currentState = getState(ref);
    if (currentState.messageBridge) {
      const updatedBridge = subscribeToAllDirectMessages(currentState.messageBridge, wrappedHandler);
      setState(ref, { ...getState(ref), messageBridge: updatedBridge });
    }

    if (libp2pPeerId && nodeState.node?.services.pubsub) {
      subscribeWithRef(ref, `peer:${libp2pPeerId}`, messageHandler);
    }
  }

  return agent;
}

export async function start(state: NodeState): Promise<StateRef<NodeState>> {
  return lifecycle.start(state);
}

export async function stop(ref: StateRef<NodeState>): Promise<void> {
  await lifecycle.stop(ref);
}

export async function publish(ref: StateRef<NodeState>, topic: string, event: EccoEvent): Promise<void> {
  const state = getState(ref);
  await publishFn(state, topic, event);
}

export function subscribeToTopic(ref: StateRef<NodeState>, topic: string, handler: (event: EccoEvent) => void): () => void {
  return subscribeWithRef(ref, topic, handler);
}

export async function findPeers(
  ref: StateRef<NodeState>,
  query?: CapabilityQuery
): Promise<CapabilityMatch[]> {
  const effectiveQuery: CapabilityQuery = query ?? { requiredCapabilities: [] };
  return findPeersImpl(ref, effectiveQuery);
}

export { findPeersWithPriorityImpl as findPeersWithPriority };

export async function sendMessage(ref: StateRef<NodeState>, peerId: string, message: Message): Promise<void> {
  await lifecycle.sendMessage(ref, peerId, message);
}

export function getCapabilities(ref: StateRef<NodeState>): Capability[] {
  const state = getState(ref);
  return [...state.capabilities];
}

export async function addCapability(ref: StateRef<NodeState>, capability: Capability): Promise<void> {
  const state = getState(ref);
  const newState = { ...state, capabilities: [...state.capabilities, capability] };
  setState(ref, newState);
  await announceCapabilities(newState);
}

export function getMultiaddrs(ref: StateRef<NodeState>): string[] {
  const state = getState(ref);
  if (!state.node) {
    return [];
  }
  return state.node.getMultiaddrs().map(String);
}

export function getId(ref: StateRef<NodeState>): string {
  const state = getState(ref);
  return state.id;
}

export function getLibp2pPeerId(ref: StateRef<NodeState>): string | undefined {
  const state = getState(ref);
  return state.node?.peerId?.toString();
}

export async function broadcastCapabilities(ref: StateRef<NodeState>): Promise<void> {
  const state = getState(ref);
  await announceCapabilities(state);
}

export type { NodeState } from './types';
export { loadOrCreateNodeIdentity } from './identity';

export {
  createReputationState,
  getLocalReputation,
  recordLocalSuccess,
  recordLocalFailure,
  queueRating,
  commitPendingRatings,
  shouldCommit,
  syncPeerFromChain,
  syncAllPeersFromChain,
  getEffectiveScore,
  getPeersByScore,
  getStakedPeers as getStakedPeersFromReputation,
  resolveWalletForPeer,
} from './reputation';
export type { LocalPeerReputation, ReputationState, ReputationConfig, PendingRating } from './reputation';

export {
  createPeerTracker,
  trackSuccess,
  trackFailure,
  getPeerScore,
  getAllPeerScores,
  getTopPeers,
  getStakedPeers,
  syncPeerReputation,
  commitRatings,
  getPendingRatingsCount,
} from './peer-tracker';
export type { PeerTrackerState, PeerScore, TrackSuccessOptions, TrackFailureOptions } from './peer-tracker';

export {
  createPerformanceTracker,
  setupPerformanceTracking,
  recordSuccess as recordPerformanceSuccess,
  recordFailure as recordPerformanceFailure,
  getMetrics as getPerformanceMetrics,
  calculatePerformanceScore,
  calculateSuccessRate,
  calculateAverageLatency,
  getAllMetrics as getAllPerformanceMetrics,
} from './peer-performance';
export type { PeerMetrics, PeerPerformanceState } from './peer-performance';

export {
  createBloomFilterState,
  createFilter,
  addToFilter,
  testFilter,
  mergeFilters,
  buildLocalFilters,
  receiveFilter,
  queryFilter,
  findCandidates,
  serializeFilter,
  deserializeFilter,
  gossipFilters,
  subscribeToFilters,
  shouldGossip,
  estimateFalsePositiveRate,
  getFilterStats,
} from './bloom-filter';
export type { FilterTier, ReputationBloomFilter, BloomFilterState, BloomFilterConfig } from './bloom-filter';

export {
  createLatencyZoneState,
  classifyLatency,
  updatePeerZone,
  getPeerZone,
  getPeersInZone,
  getPeersUpToZone,
  getZoneStats,
  getAllZoneStats,
  syncFromPerformance,
  filterByZone,
  sortByZone,
  selectByZoneWithFallback,
  estimateLatencyByZone,
  getZoneWeight,
  calculateZoneScore,
} from './latency-zones';
export type { LatencyZone, ZoneThresholds, LatencyZoneState, ZoneStat, LatencyZoneConfig, ZoneSelectionConfig } from './latency-zones';
