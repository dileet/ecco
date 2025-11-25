import type { NodeState } from './types';
import type { PeerInfo } from '../types';
import type { EccoEvent } from '../events';

export function addPeer(state: NodeState, peer: PeerInfo): NodeState {
  const newPeers = new Map(state.peers);
  newPeers.set(peer.id, peer);
  return { ...state, peers: newPeers };
}

export function removePeer(state: NodeState, peerId: string): NodeState {
  const newPeers = new Map(state.peers);
  newPeers.delete(peerId);
  return { ...state, peers: newPeers };
}

export function updatePeer(state: NodeState, peerId: string, updates: Partial<PeerInfo>): NodeState {
  const existing = state.peers.get(peerId);
  if (!existing) {
    return state;
  }

  const newPeers = new Map(state.peers);
  newPeers.set(peerId, { ...existing, ...updates });
  return { ...state, peers: newPeers };
}

export function addSubscription(state: NodeState, topic: string, handler: (event: EccoEvent) => void): NodeState {
  const newSubscriptions = new Map(state.subscriptions);

  if (!newSubscriptions.has(topic)) {
    newSubscriptions.set(topic, new Set());
  }

  // Mutate the existing Set so event listeners can see the handler
  // This is necessary because event listeners have closures over the state
  const handlers = newSubscriptions.get(topic)!;
  handlers.add(handler);

  return { ...state, subscriptions: newSubscriptions };
}
