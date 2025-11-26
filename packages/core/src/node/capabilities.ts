import { nanoid } from 'nanoid';
import type { NodeState, StateRef } from './types';
import type { Capability, CapabilityQuery, CapabilityMatch } from '../types';
import { publish, subscribe } from './messaging';
import { matchPeers } from '../orchestrator/capability-matcher';
import { getState, updateState, addPeer, updatePeer, setCapabilityTrackingSetup } from './state';
import type { CapabilityAnnouncementEvent, CapabilityRequestEvent, CapabilityResponseEvent, EccoEvent } from '../events';

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
  if (state.config.discovery.includes('gossip') && state.node?.services.pubsub) {
    await publish(state, 'ecco:capabilities', {
      type: 'capability-announcement',
      peerId: state.id,
      capabilities: state.capabilities,
      timestamp: Date.now(),
    });
  }

  if (state.config.discovery.includes('dht') && state.node?.services.dht) {
    const { DHT } = await import('./dht');
    const addresses = state.node.getMultiaddrs().map(String);
    await DHT.announceCapabilities(state.node, state.id, state.capabilities, addresses, {
      waitForReady: true,
      minPeers: 1,
      timeout: 10000,
      retries: 2,
    });
  }
}

export function setupCapabilityTracking(stateRef: StateRef<NodeState>): void {
  const state = getState(stateRef);

  if (state.capabilityTrackingSetup) {
    return;
  }

  if (!state.node?.services.pubsub) {
    console.log('[Capabilities] Gossipsub not enabled, skipping capability tracking setup');
    updateState(stateRef, (s) => setCapabilityTrackingSetup(s, true));
    return;
  }

  let currentState = state;

  currentState = subscribe(currentState, 'ecco:capabilities', (event: EccoEvent) => {
    if (event.type !== 'capability-announcement') return;
    const { peerId, capabilities, timestamp } = event as CapabilityAnnouncementEvent;

    const current = getState(stateRef);
    const existingPeer = current.peers[peerId];

    if (existingPeer && hasCapabilitiesChanged(existingPeer.capabilities, capabilities)) {
      console.log(`Updated capabilities for peer ${peerId}:`, capabilities.map((c) => c.name).join(', '));
    } else if (!existingPeer) {
      console.log(`Added new peer from announcement: ${peerId}`);
    }

    updateOrAddPeer(stateRef, peerId, capabilities, timestamp);
  });

  currentState = subscribe(currentState, 'ecco:capability-request', async (event: EccoEvent) => {
    if (event.type !== 'capability-request') return;
    const { requestId, from, requiredCapabilities, preferredPeers, timestamp } = event as CapabilityRequestEvent;

    const current = getState(stateRef);
    console.log(`[${current.id}] Received capability request from ${from}`);

    if (!current.peers[from]) {
      updateOrAddPeer(stateRef, from, [], timestamp);
    }

    if (from === current.id) return;

    const matches = matchPeers(
      [{ id: current.id, addresses: [], capabilities: current.capabilities, lastSeen: Date.now() }],
      { requiredCapabilities, preferredPeers }
    );

    if (matches.length > 0) {
      await publish(current, 'ecco:capability-response', {
        type: 'capability-response',
        requestId,
        peerId: current.id,
        capabilities: current.capabilities,
        timestamp: Date.now(),
      });
      console.log(`[${current.id}] Sent capability response to ${from}`);
    }
  });

  currentState = subscribe(currentState, 'ecco:capability-response', (event: EccoEvent) => {
    if (event.type !== 'capability-response') return;
    const { peerId, capabilities, timestamp } = event as CapabilityResponseEvent;

    console.log(`Received capability response from ${peerId}`);
    updateOrAddPeer(stateRef, peerId, capabilities, timestamp);
  });

  updateState(stateRef, () => setCapabilityTrackingSetup(currentState, true));
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
