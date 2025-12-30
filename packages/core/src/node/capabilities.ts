import type { PrivateKey } from '@libp2p/interface';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import type { NodeState, StateRef } from './types';
import type { Capability, CapabilityQuery, CapabilityMatch } from '../types';
import { publish, subscribeWithRef } from './messaging';
import { matchPeers } from '../orchestrator/capability-matcher';
import { getState, updateState, addPeer, updatePeer, setCapabilityTrackingSetup, hasPeer, getAllPeers } from './state';
import type { CapabilityAnnouncementEvent, CapabilityRequestEvent, CapabilityResponseEvent, EccoEvent } from '../events';
import { announceCapabilities as announceDHT } from './dht';
import { canonicalJsonStringify } from '../utils/canonical-json';

const ED25519_SIGNATURE_LENGTH = 64;

interface SignedCapabilityEvent {
  signature?: number[];
  publicKey?: number[];
}

type CapabilityAnnouncementPayload = {
  type: 'capability-announcement';
  peerId: string;
  libp2pPeerId?: string;
  capabilities: Capability[];
  timestamp: number;
};

type CapabilityRequestPayload = {
  type: 'capability-request';
  requestId: string;
  from: string;
  requiredCapabilities: Partial<Capability>[];
  preferredPeers?: string[];
  timestamp: number;
};

type CapabilityResponsePayload = {
  type: 'capability-response';
  requestId: string;
  peerId: string;
  libp2pPeerId?: string;
  capabilities: Capability[];
  timestamp: number;
};

function createAnnouncementSignaturePayload(event: CapabilityAnnouncementPayload): Uint8Array {
  const payload = canonicalJsonStringify({
    type: event.type,
    peerId: event.peerId,
    libp2pPeerId: event.libp2pPeerId,
    capabilities: event.capabilities,
    timestamp: event.timestamp,
  });
  return new TextEncoder().encode(payload);
}

function createRequestSignaturePayload(event: CapabilityRequestPayload): Uint8Array {
  const payload = canonicalJsonStringify({
    type: event.type,
    requestId: event.requestId,
    from: event.from,
    requiredCapabilities: event.requiredCapabilities,
    preferredPeers: event.preferredPeers,
    timestamp: event.timestamp,
  });
  return new TextEncoder().encode(payload);
}

function createResponseSignaturePayload(event: CapabilityResponsePayload): Uint8Array {
  const payload = canonicalJsonStringify({
    type: event.type,
    requestId: event.requestId,
    peerId: event.peerId,
    libp2pPeerId: event.libp2pPeerId,
    capabilities: event.capabilities,
    timestamp: event.timestamp,
  });
  return new TextEncoder().encode(payload);
}

async function signCapabilityEvent<T extends CapabilityAnnouncementPayload | CapabilityRequestPayload | CapabilityResponsePayload>(
  event: T,
  privateKey: PrivateKey,
  createPayload: (e: T) => Uint8Array
): Promise<T & SignedCapabilityEvent> {
  const data = createPayload(event);
  const signature = await privateKey.sign(data);
  const publicKeyBytes = privateKey.publicKey.raw;

  return {
    ...event,
    signature: Array.from(new Uint8Array(signature)),
    publicKey: Array.from(new Uint8Array(publicKeyBytes)),
  };
}

async function verifyCapabilityEvent<T extends CapabilityAnnouncementPayload | CapabilityRequestPayload | CapabilityResponsePayload>(
  event: T & SignedCapabilityEvent,
  expectedPeerId: string,
  createPayload: (e: T) => Uint8Array
): Promise<boolean> {
  if (!event.signature || !event.publicKey) {
    return false;
  }

  const signatureBytes = new Uint8Array(event.signature);
  const publicKeyBytes = new Uint8Array(event.publicKey);

  if (signatureBytes.length !== ED25519_SIGNATURE_LENGTH) {
    return false;
  }

  try {
    const publicKey = publicKeyFromRaw(publicKeyBytes);
    const derivedPeerId = peerIdFromPublicKey(publicKey);

    if (derivedPeerId.toString().toLowerCase() !== expectedPeerId.toLowerCase()) {
      return false;
    }

    const baseEvent = { ...event };
    delete (baseEvent as SignedCapabilityEvent).signature;
    delete (baseEvent as SignedCapabilityEvent).publicKey;

    const data = createPayload(baseEvent as T);
    return await publicKey.verify(data, signatureBytes);
  } catch {
    return false;
  }
}

const hasCapabilitiesChanged = (existing: Capability[], updated: Capability[]): boolean =>
  JSON.stringify(existing) !== JSON.stringify(updated);

const updateOrAddPeer = (
  stateRef: StateRef<NodeState>,
  peerId: string,
  capabilities: Capability[],
  timestamp: number
): void => {
  const current = getState(stateRef);
  if (hasPeer(current, peerId)) {
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
    if (!state.libp2pPrivateKey || !libp2pPeerId) {
      return;
    }

    const baseEvent: CapabilityAnnouncementPayload = {
      type: 'capability-announcement',
      peerId: state.id,
      libp2pPeerId,
      capabilities: state.capabilities,
      timestamp: Date.now(),
    };

    const signedEvent = await signCapabilityEvent(
      baseEvent,
      state.libp2pPrivateKey,
      createAnnouncementSignaturePayload
    );

    await publish(state, 'ecco:capabilities', signedEvent);
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

  subscribeWithRef(stateRef, 'ecco:capabilities', async (event: EccoEvent) => {
    if (event.type !== 'capability-announcement') return;
    const announcementEvent = event as CapabilityAnnouncementEvent;
    const { peerId, libp2pPeerId, capabilities, timestamp, signature, publicKey } = announcementEvent;

    const current = getState(stateRef);
    if (peerId.toLowerCase() === current.id.toLowerCase()) return;
    if (libp2pPeerId && libp2pPeerId.toLowerCase() === current.node?.peerId?.toString().toLowerCase()) return;

    const expectedPeerId = libp2pPeerId ?? peerId;
    const isValid = await verifyCapabilityEvent(
      { type: 'capability-announcement', peerId, libp2pPeerId, capabilities, timestamp, signature, publicKey },
      expectedPeerId,
      createAnnouncementSignaturePayload
    );

    if (!isValid) {
      return;
    }

    const targetPeerId = libp2pPeerId ?? peerId;
    updateOrAddPeer(stateRef, targetPeerId, capabilities, timestamp);
  });

  subscribeWithRef(stateRef, 'ecco:capability-request', async (event: EccoEvent) => {
    if (event.type !== 'capability-request') return;
    const requestEvent = event as CapabilityRequestEvent;
    const { requestId, from, requiredCapabilities, preferredPeers, timestamp, signature, publicKey } = requestEvent;

    const current = getState(stateRef);

    if (from === current.id) return;

    const isValid = await verifyCapabilityEvent(
      { type: 'capability-request', requestId, from, requiredCapabilities, preferredPeers, timestamp, signature, publicKey },
      from,
      createRequestSignaturePayload
    );

    if (!isValid) {
      return;
    }

    if (!hasPeer(current, from)) {
      updateOrAddPeer(stateRef, from, [], timestamp);
    }

    const matches = matchPeers(
      [{ id: current.id, addresses: [], capabilities: current.capabilities, lastSeen: Date.now() }],
      { requiredCapabilities, preferredPeers }
    );

    if (matches.length > 0) {
      const latestState = getState(stateRef);
      const libp2pPeerId = latestState.node?.peerId?.toString();

      if (!latestState.libp2pPrivateKey || !libp2pPeerId) {
        return;
      }

      const baseResponse: CapabilityResponsePayload = {
        type: 'capability-response',
        requestId,
        peerId: latestState.id,
        libp2pPeerId,
        capabilities: latestState.capabilities,
        timestamp: Date.now(),
      };

      const signedResponse = await signCapabilityEvent(
        baseResponse,
        latestState.libp2pPrivateKey,
        createResponseSignaturePayload
      );

      await publish(latestState, 'ecco:capability-response', signedResponse);
    }
  });

  subscribeWithRef(stateRef, 'ecco:capability-response', async (event: EccoEvent) => {
    if (event.type !== 'capability-response') return;
    const responseEvent = event as CapabilityResponseEvent;
    const { requestId, peerId, libp2pPeerId, capabilities, timestamp, signature, publicKey } = responseEvent;

    const expectedPeerId = libp2pPeerId ?? peerId;
    const isValid = await verifyCapabilityEvent(
      { type: 'capability-response', requestId, peerId, libp2pPeerId, capabilities, timestamp, signature, publicKey },
      expectedPeerId,
      createResponseSignaturePayload
    );

    if (!isValid) {
      return;
    }

    const targetPeerId = libp2pPeerId ?? peerId;
    updateOrAddPeer(stateRef, targetPeerId, capabilities, timestamp);
  });

  updateState(stateRef, (s) => setCapabilityTrackingSetup(s, true));
}

export function findMatchingPeers(state: NodeState, query: CapabilityQuery): CapabilityMatch[] {
  return matchPeers(getAllPeers(state), query);
}

export async function requestCapabilities(stateRef: StateRef<NodeState>, query: CapabilityQuery): Promise<void> {
  const state = getState(stateRef);
  const libp2pPeerId = state.node?.peerId?.toString();

  if (!state.libp2pPrivateKey || !libp2pPeerId) {
    return;
  }

  const baseRequest: CapabilityRequestPayload = {
    type: 'capability-request',
    requestId: crypto.randomUUID(),
    from: libp2pPeerId,
    requiredCapabilities: query.requiredCapabilities,
    preferredPeers: query.preferredPeers,
    timestamp: Date.now(),
  };

  const signedRequest = await signCapabilityEvent(
    baseRequest,
    state.libp2pPrivateKey,
    createRequestSignaturePayload
  );

  await publish(state, 'ecco:capability-request', signedRequest);
}
