import type { PeerId } from '@libp2p/interface';
import type { NodeState, StateRef } from './types';
import { announceCapabilities, setupCapabilityTracking } from './capabilities';
import { setupPerformanceTracking } from './peer-performance';
import { getState, updateState, removePeer } from './state';

export function setupEventListeners(
  state: NodeState,
  stateRef: StateRef<NodeState>
): void {
  if (!state.node) {
    return;
  }

  const node = state.node;
  const discoveredPeers = new Set<string>();

  node.addEventListener('peer:discovery', async (evt: CustomEvent<{ id: PeerId; multiaddrs: unknown[] }>) => {
    const { id: peerId } = evt.detail;
    const peerIdStr = peerId.toString();

    if (discoveredPeers.has(peerIdStr)) {
      console.log(`[${state.id}] Already discovered ${peerIdStr}, skipping`);
      return;
    }

    discoveredPeers.add(peerIdStr);
    console.log(`[${state.id}] Discovered peer: ${peerIdStr}`);

    try {
      await node.dial(peerId);
      console.log(`[${state.id}] Dialed peer: ${peerIdStr}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (!errorMessage.includes('ECONNREFUSED') && !errorMessage.includes('timeout')) {
        console.warn(`[${state.id}] Failed to dial peer: ${peerIdStr}`, errorMessage);
      }
    }
  });

  node.addEventListener('peer:connect', (evt: CustomEvent<PeerId>) => {
    const peerId = evt.detail.toString();
    console.log('Connected to peer:', peerId);
    handlePeerConnect(stateRef);
  });

  node.addEventListener('peer:disconnect', (evt: CustomEvent<PeerId>) => {
    const peerId = evt.detail.toString();
    console.log('Disconnected from peer:', peerId);
    updateState(stateRef, (s) => removePeer(s, peerId));
  });
}

function handlePeerConnect(stateRef: StateRef<NodeState>): void {
  setupCapabilityTracking(stateRef);
  updateState(stateRef, setupPerformanceTracking);
  const state = getState(stateRef);
  announceCapabilities(state);
}
