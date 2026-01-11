import type {
  TransportAdapter,
  TransportType,
  TransportPeer,
  TransportMessage,
  TransportManagerConfig,
  TransportDiscoveryEvent,
  TransportConnectionEvent,
  ProximityInfo,
} from './transport-types';
import { MANAGER } from './transport-constants';

export interface TransportManagerState {
  config: TransportManagerConfig;
  adapters: Map<TransportType, TransportAdapter>;
  connectedPeers: Map<string, TransportPeer>;
  discoveredPeers: Map<string, TransportPeer>;
  proximityPeers: Map<string, ProximityInfo>;
  cleanups: Array<() => void>;
}

export interface TransportManagerStateRef {
  current: TransportManagerState;
}

export function createStateRef(state: TransportManagerState): TransportManagerStateRef {
  return { current: state };
}

export function createTransportManager(
  config: TransportManagerConfig
): TransportManagerState {
  return {
    config,
    adapters: new Map(),
    connectedPeers: new Map(),
    discoveredPeers: new Map(),
    proximityPeers: new Map(),
    cleanups: [],
  };
}

export function registerAdapter(
  state: TransportManagerState,
  adapter: TransportAdapter
): TransportManagerState {
  const adapters = new Map(state.adapters);
  adapters.set(adapter.type, adapter);
  return { ...state, adapters };
}

export async function initializeAdapters(
  state: TransportManagerState
): Promise<TransportManagerState> {
  const initPromises = Array.from(state.adapters.values()).map(async (adapter) => {
    await adapter.initialize();
  });
  
  await Promise.all(initPromises);
  return state;
}

export async function startDiscovery(
  stateRef: TransportManagerStateRef
): Promise<TransportManagerState> {
  const cleanups: Array<() => void> = [];

  for (const adapter of stateRef.current.adapters.values()) {
    await adapter.startDiscovery();

    const discoveryCleanup = adapter.onDiscovery((event) => {
      stateRef.current = handleDiscoveryEvent(stateRef.current, event);
    });
    cleanups.push(discoveryCleanup);

    const connectionCleanup = adapter.onConnection((event) => {
      stateRef.current = handleConnectionEvent(stateRef.current, event);
    });
    cleanups.push(connectionCleanup);
  }

  stateRef.current = { ...stateRef.current, cleanups: [...stateRef.current.cleanups, ...cleanups] };
  return stateRef.current;
}

function handleDiscoveryEvent(
  state: TransportManagerState,
  event: TransportDiscoveryEvent
): TransportManagerState {
  const discoveredPeers = new Map(state.discoveredPeers);
  const proximityPeers = new Map(state.proximityPeers);

  switch (event.type) {
    case 'discovered':
    case 'updated':
      discoveredPeers.set(event.peer.id, event.peer);

      if (event.peer.rssi !== undefined) {
        const proximity = rssiToDistance(event.peer.rssi);
        proximityPeers.set(event.peer.id, {
          peerId: event.peer.id,
          transport: event.peer.transport,
          rssi: event.peer.rssi,
          distance: proximity,
          lastSeen: event.peer.lastSeen,
        });
      }
      break;

    case 'lost':
      discoveredPeers.delete(event.peer.id);
      proximityPeers.delete(event.peer.id);
      break;
  }

  return { ...state, discoveredPeers, proximityPeers };
}

function handleConnectionEvent(
  state: TransportManagerState,
  event: TransportConnectionEvent
): TransportManagerState {
  const connectedPeers = new Map(state.connectedPeers);

  switch (event.type) {
    case 'connected': {
      const peer = state.discoveredPeers.get(event.peerId);
      if (peer) {
        connectedPeers.set(event.peerId, peer);
      }
      break;
    }
    case 'disconnected':
    case 'error':
      connectedPeers.delete(event.peerId);
      break;
  }

  return { ...state, connectedPeers };
}

function rssiToDistance(rssi: number): ProximityInfo['distance'] {
  if (!Number.isFinite(rssi) || rssi < MANAGER.MIN_RSSI || rssi > MANAGER.MAX_RSSI) {
    return 'unknown';
  }
  if (rssi >= -50) return 'immediate';
  if (rssi >= -70) return 'near';
  if (rssi >= -90) return 'far';
  return 'unknown';
}

export function getProximityPeers(
  state: TransportManagerState,
  maxDistance: ProximityInfo['distance'] = 'far'
): ProximityInfo[] {
  const distanceOrder = ['immediate', 'near', 'far', 'unknown'] as const;
  const maxIndex = distanceOrder.indexOf(maxDistance);
  
  return Array.from(state.proximityPeers.values())
    .filter((p) => {
      const peerIndex = distanceOrder.indexOf(p.distance ?? 'unknown');
      return peerIndex <= maxIndex;
    })
    .sort((a, b) => (b.rssi ?? -100) - (a.rssi ?? -100));
}

export async function connectToPeer(
  state: TransportManagerState,
  peerId: string,
  preferredTransport?: TransportType
): Promise<boolean> {
  const peer = state.discoveredPeers.get(peerId);
  if (!peer) return false;
  
  const transport = preferredTransport ?? peer.transport;
  const adapter = state.adapters.get(transport);
  
  if (!adapter) return false;
  
  await adapter.connect(peerId);
  return true;
}

export async function sendMessage(
  state: TransportManagerState,
  peerId: string,
  message: TransportMessage
): Promise<boolean> {
  const peer = state.connectedPeers.get(peerId);
  if (!peer) return false;
  
  const adapter = state.adapters.get(peer.transport);
  if (!adapter) return false;
  
  await adapter.send(peerId, message);
  return true;
}

export async function broadcastMessage(
  state: TransportManagerState,
  message: TransportMessage
): Promise<void> {
  const broadcastPromises = Array.from(state.adapters.values()).map(
    async (adapter) => {
      await adapter.broadcast(message);
    }
  );
  
  await Promise.all(broadcastPromises);
}

export async function shutdown(
  state: TransportManagerState
): Promise<TransportManagerState> {
  for (const cleanup of state.cleanups) {
    cleanup();
  }
  
  const shutdownPromises = Array.from(state.adapters.values()).map(
    async (adapter) => {
      await adapter.shutdown();
    }
  );
  
  await Promise.all(shutdownPromises);
  
  return {
    ...state,
    connectedPeers: new Map(),
    discoveredPeers: new Map(),
    proximityPeers: new Map(),
    cleanups: [],
  };
}

export function getBestTransportForPeer(
  state: TransportManagerState,
  peerId: string
): TransportType | null {
  const peer = state.discoveredPeers.get(peerId) ?? state.connectedPeers.get(peerId);
  if (!peer) return null;
  
  const proximity = state.proximityPeers.get(peerId);
  
  if (proximity?.distance === 'immediate' && state.adapters.has('bluetooth-le')) {
    return 'bluetooth-le';
  }

  if (state.adapters.has('libp2p')) {
    return 'libp2p';
  }
  
  return peer.transport;
}

