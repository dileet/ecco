import { nanoid } from 'nanoid';
import type { NodeState, StateRef } from './types';
import type { Capability, CapabilityQuery, CapabilityMatch } from '../types';
import { publish, subscribeWithRef } from './messaging';
import { matchPeers } from '../orchestrator/capability-matcher';
import { getState, updateState, addPeer, updatePeer, setCapabilityTrackingSetup } from './state';
import type { CapabilityAnnouncementEvent, CapabilityRequestEvent, CapabilityResponseEvent, EccoEvent } from '../events';
import { announceCapabilities as announceDHT } from './dht';

const hasCapabilitiesChanged = (existing: Capability[], updated: Capability[]): boolean =>
  JSON.stringify(existing) !== JSON.stringify(updated);

const updateOrAddPeer = (
  stateRef: StateRef<NodeState>,
  peerId: string,
  capabilities: Capability[],
  timestamp: number
): void => {
  const current = getState(stateRef);
  if (current.peers[peerId]) {
    updateState(stateRef, (s) =>
      updatePeer(s, peerId, { capabilities, lastSeen: timestamp })
    );
  } else {
    updateState(stateRef, (s) =>
      addPeer(s, { id: peerId, addresses: [], capabilities, lastSeen: timestamp })
    );
  }
};

export async function announceCapabilities(state: NodeState): Promise<void> {
  const libp2pPeerId = state.node?.peerId?.toString();
  
  if (state.config.discovery.includes('gossip') && state.node?.services.pubsub) {
    await publish(state, 'ecco:capabilities', {
      type: 'capability-announcement',
      peerId: state.id,
      libp2pPeerId,
      capabilities: state.capabilities,
      timestamp: Date.now(),
    });
  }

  if (state.config.discovery.includes('dht') && state.node?.services.dht) {
    await announceDHT(state.node, state.capabilities);
  }
}

export function setupCapabilityTracking(stateRef: StateRef<NodeState>): void {
  const state = getState(stateRef);

  if (state.capabilityTrackingSetup) {
    return;
  }

  if (!state.node?.services.pubsub) {
    updateState(stateRef, (s) => setCapabilityTrackingSetup(s, true));
    return;
  }

  subscribeWithRef(stateRef, 'ecco:capabilities', (event: EccoEvent) => {
    if (event.type !== 'capability-announcement') return;
    const { peerId, libp2pPeerId, capabilities, timestamp } = event as CapabilityAnnouncementEvent;

    const current = getState(stateRef);
    if (peerId === current.id) return;
    if (libp2pPeerId && libp2pPeerId === current.node?.peerId?.toString()) return;
    
    const targetPeerId = libp2pPeerId ?? peerId;
    updateOrAddPeer(stateRef, targetPeerId, capabilities, timestamp);
  });

  subscribeWithRef(stateRef, 'ecco:capability-request', async (event: EccoEvent) => {
    if (event.type !== 'capability-request') return;
    const { requestId, from, requiredCapabilities, preferredPeers, timestamp } = event as CapabilityRequestEvent;

    const current = getState(stateRef);

    if (!current.peers[from]) {
      updateOrAddPeer(stateRef, from, [], timestamp);
    }

    if (from === current.id) return;

    const matches = matchPeers(
      [{ id: current.id, addresses: [], capabilities: current.capabilities, lastSeen: Date.now() }],
      { requiredCapabilities, preferredPeers }
    );

    if (matches.length > 0) {
      const latestState = getState(stateRef);
      const libp2pPeerId = latestState.node?.peerId?.toString();
      await publish(latestState, 'ecco:capability-response', {
        type: 'capability-response',
        requestId,
        peerId: latestState.id,
        libp2pPeerId,
        capabilities: latestState.capabilities,
        timestamp: Date.now(),
      });
    }
  });

  subscribeWithRef(stateRef, 'ecco:capability-response', (event: EccoEvent) => {
    if (event.type !== 'capability-response') return;
    const { peerId, libp2pPeerId, capabilities, timestamp } = event as CapabilityResponseEvent;
    const targetPeerId = libp2pPeerId ?? peerId;
    updateOrAddPeer(stateRef, targetPeerId, capabilities, timestamp);
  });

  updateState(stateRef, (s) => setCapabilityTrackingSetup(s, true));
}

export function findMatchingPeers(state: NodeState, query: CapabilityQuery): CapabilityMatch[] {
  return matchPeers(Object.values(state.peers), query);
}

export async function requestCapabilities(stateRef: StateRef<NodeState>, query: CapabilityQuery): Promise<void> {
  const state = getState(stateRef);

  await publish(state, 'ecco:capability-request', {
    type: 'capability-request',
    requestId: nanoid(),
    from: state.id,
    requiredCapabilities: query.requiredCapabilities,
    preferredPeers: query.preferredPeers,
    timestamp: Date.now(),
  });
}
