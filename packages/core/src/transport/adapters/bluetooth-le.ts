import type {
  TransportAdapter,
  TransportType,
  TransportState,
  TransportPeer,
  TransportMessage,
  TransportDiscoveryEvent,
  TransportConnectionEvent,
  BeaconConfig,
  LocalContext,
} from '../types';
import type { NetworkConfig } from '../../networks';
import { z } from 'zod';

const LocalContextSchema = z.object({
  locationId: z.string().optional(),
  locationName: z.string().optional(),
  capabilities: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export interface BLEAdapterConfig {
  serviceUUID: string;
  characteristicUUID: string;
  beacon?: BeaconConfig;
  advertise?: boolean;
  scan?: boolean;
  scanInterval?: number;
  networkConfig?: NetworkConfig;
}

export interface BLEAdapterState {
  config: BLEAdapterConfig;
  state: TransportState;
  discoveredPeers: Map<string, TransportPeer>;
  connectedPeers: Map<string, TransportPeer>;
  localContext?: LocalContext;
  discoveryHandlers: Set<(event: TransportDiscoveryEvent) => void>;
  connectionHandlers: Set<(event: TransportConnectionEvent) => void>;
  messageHandlers: Set<(peerId: string, message: TransportMessage) => void>;
  nativeBridge?: BLENativeBridge;
  eventCleanups: Array<() => void>;
}

export interface BLENativeBridge {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  startScanning(serviceUUIDs: string[]): Promise<void>;
  stopScanning(): Promise<void>;
  startAdvertising(config: BLEAdvertisingConfig): Promise<void>;
  stopAdvertising(): Promise<void>;
  connect(peerId: string): Promise<void>;
  disconnect(peerId: string): Promise<void>;
  write(peerId: string, data: Uint8Array): Promise<void>;
  read(peerId: string): Promise<Uint8Array>;
  onPeripheralDiscovered(handler: (peripheral: BLEPeripheral) => void): () => void;
  onPeripheralConnected(handler: (peerId: string) => void): () => void;
  onPeripheralDisconnected(handler: (peerId: string) => void): () => void;
  onDataReceived(handler: (peerId: string, data: Uint8Array) => void): () => void;
}

export interface BLEPeripheral {
  id: string;
  name?: string;
  rssi: number;
  advertisementData?: {
    localName?: string;
    serviceUUIDs?: string[];
    manufacturerData?: Uint8Array;
    serviceData?: Record<string, Uint8Array>;
  };
}

export interface BLEAdvertisingConfig {
  localName: string;
  serviceUUIDs: string[];
  manufacturerData?: Uint8Array;
}

const ECCO_SERVICE_UUID = '155b45d0-db4d-4587-9237-06089f2bf639';
const ECCO_CHAR_UUID = '2f436cd1-a421-48a7-bc84-43949ed40fa5';

export function createBLEAdapter(
  config: Partial<BLEAdapterConfig> = {}
): BLEAdapterState {
  return {
    config: {
      serviceUUID: config.serviceUUID ?? ECCO_SERVICE_UUID,
      characteristicUUID: config.characteristicUUID ?? ECCO_CHAR_UUID,
      beacon: config.beacon,
      advertise: config.advertise ?? true,
      scan: config.scan ?? true,
      scanInterval: config.scanInterval ?? 3000,
    },
    state: 'disconnected',
    discoveredPeers: new Map(),
    connectedPeers: new Map(),
    discoveryHandlers: new Set(),
    connectionHandlers: new Set(),
    messageHandlers: new Set(),
    eventCleanups: [],
  };
}

export function setBridge(
  state: BLEAdapterState,
  bridge: BLENativeBridge
): BLEAdapterState {
  return { ...state, nativeBridge: bridge };
}

export function setLocalContext(
  state: BLEAdapterState,
  context: LocalContext
): BLEAdapterState {
  return { ...state, localContext: context };
}

export async function initialize(state: BLEAdapterState): Promise<BLEAdapterState> {
  if (!state.nativeBridge) {
    console.warn('BLE: No native bridge configured, running in mock mode');
    return { ...state, state: 'connected' };
  }
  
  await state.nativeBridge.initialize();
  return { ...state, state: 'connected' };
}

export async function shutdown(state: BLEAdapterState): Promise<BLEAdapterState> {
  for (const cleanup of state.eventCleanups) {
    cleanup();
  }

  if (state.nativeBridge) {
    await state.nativeBridge.stopScanning();
    await state.nativeBridge.stopAdvertising();
    await state.nativeBridge.shutdown();
  }

  return {
    ...state,
    state: 'disconnected',
    discoveredPeers: new Map(),
    connectedPeers: new Map(),
    eventCleanups: [],
  };
}

export async function startDiscovery(state: BLEAdapterState): Promise<BLEAdapterState> {
  if (!state.nativeBridge) return state;
  
  const connectionCleanup = state.nativeBridge.onPeripheralConnected((peerId) => {
    const peer = state.discoveredPeers.get(peerId) ?? {
      id: peerId,
      transport: 'bluetooth-le',
      addresses: [`ble://${peerId}`],
      lastSeen: Date.now(),
    };

    state.connectedPeers.set(peerId, peer);

    for (const handler of state.connectionHandlers) {
      handler({ type: 'connected', peerId, transport: 'bluetooth-le' });
    }
  });
  state.eventCleanups.push(connectionCleanup);

  const disconnectCleanup = state.nativeBridge.onPeripheralDisconnected((peerId) => {
    state.connectedPeers.delete(peerId);

    for (const handler of state.connectionHandlers) {
      handler({ type: 'disconnected', peerId, transport: 'bluetooth-le' });
    }
  });
  state.eventCleanups.push(disconnectCleanup);

  if (state.config.scan) {
    await state.nativeBridge.startScanning([state.config.serviceUUID]);

    const cleanup = state.nativeBridge.onPeripheralDiscovered((peripheral) => {
      const peer = peripheralToPeer(peripheral);
      state.discoveredPeers.set(peer.id, peer);

      for (const handler of state.discoveryHandlers) {
        handler({ type: 'discovered', peer });
      }
    });
    state.eventCleanups.push(cleanup);
  }
  
  if (state.config.advertise) {
    const advertisingConfig: BLEAdvertisingConfig = {
      localName: state.localContext?.locationName ?? 'Ecco Node',
      serviceUUIDs: [state.config.serviceUUID],
      manufacturerData: encodeLocalContext(state.localContext),
    };
    
    await state.nativeBridge.startAdvertising(advertisingConfig);
  }
  
  return state;
}

export async function stopDiscovery(state: BLEAdapterState): Promise<BLEAdapterState> {
  if (!state.nativeBridge) return state;

  for (const cleanup of state.eventCleanups) {
    cleanup();
  }
  state.eventCleanups.length = 0;

  await state.nativeBridge.stopScanning();
  await state.nativeBridge.stopAdvertising();

  return state;
}

export async function connect(
  state: BLEAdapterState,
  peerId: string
): Promise<BLEAdapterState> {
  if (!state.nativeBridge) return state;
  
  await state.nativeBridge.connect(peerId);
  return state;
}

export async function disconnect(
  state: BLEAdapterState,
  peerId: string
): Promise<BLEAdapterState> {
  if (!state.nativeBridge) return state;
  
  await state.nativeBridge.disconnect(peerId);
  return state;
}

export async function send(
  state: BLEAdapterState,
  peerId: string,
  message: TransportMessage
): Promise<void> {
  if (!state.nativeBridge) return;
  
  const data = encodeMessage(message);
  await state.nativeBridge.write(peerId, data);
}

export async function broadcast(
  state: BLEAdapterState,
  message: TransportMessage
): Promise<void> {
  const sendPromises = Array.from(state.connectedPeers.keys()).map((peerId) =>
    send(state, peerId, message)
  );
  await Promise.all(sendPromises);
}

export function onDiscovery(
  state: BLEAdapterState,
  handler: (event: TransportDiscoveryEvent) => void
): () => void {
  state.discoveryHandlers.add(handler);
  return () => state.discoveryHandlers.delete(handler);
}

export function onConnection(
  state: BLEAdapterState,
  handler: (event: TransportConnectionEvent) => void
): () => void {
  state.connectionHandlers.add(handler);
  return () => state.connectionHandlers.delete(handler);
}

export function onMessage(
  state: BLEAdapterState,
  handler: (peerId: string, message: TransportMessage) => void
): () => void {
  state.messageHandlers.add(handler);
  return () => state.messageHandlers.delete(handler);
}

export function getConnectedPeers(state: BLEAdapterState): TransportPeer[] {
  return Array.from(state.connectedPeers.values());
}

export function getDiscoveredPeers(state: BLEAdapterState): TransportPeer[] {
  return Array.from(state.discoveredPeers.values());
}

function peripheralToPeer(peripheral: BLEPeripheral): TransportPeer {
  return {
    id: peripheral.id,
    transport: 'bluetooth-le',
    addresses: [`ble://${peripheral.id}`],
    rssi: peripheral.rssi,
    lastSeen: Date.now(),
    metadata: {
      name: peripheral.name ?? peripheral.advertisementData?.localName,
      localContext: peripheral.advertisementData?.manufacturerData
        ? decodeLocalContext(peripheral.advertisementData.manufacturerData)
        : undefined,
    },
  };
}

function encodeLocalContext(context?: LocalContext): Uint8Array | undefined {
  if (!context) return undefined;
  const json = JSON.stringify(context);
  return new TextEncoder().encode(json);
}

function decodeLocalContext(data: Uint8Array): LocalContext | undefined {
  try {
    const json = new TextDecoder().decode(data);
    const result = LocalContextSchema.safeParse(JSON.parse(json));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function encodeMessage(message: TransportMessage): Uint8Array {
  const json = JSON.stringify({
    id: message.id,
    from: message.from,
    to: message.to,
    data: Array.from(message.data),
    timestamp: message.timestamp,
  });
  return new TextEncoder().encode(json);
}

export function toAdapter(state: BLEAdapterState): TransportAdapter {
  return {
    type: 'bluetooth-le' as TransportType,
    get state() { return state.state; },
    initialize: () => initialize(state).then(() => undefined),
    shutdown: () => shutdown(state).then(() => undefined),
    startDiscovery: () => startDiscovery(state).then(() => undefined),
    stopDiscovery: () => stopDiscovery(state).then(() => undefined),
    connect: (peerId: string) => connect(state, peerId).then(() => undefined),
    disconnect: (peerId: string) => disconnect(state, peerId).then(() => undefined),
    send: (peerId: string, message: TransportMessage) => send(state, peerId, message),
    broadcast: (message: TransportMessage) => broadcast(state, message),
    getConnectedPeers: () => getConnectedPeers(state),
    getDiscoveredPeers: () => getDiscoveredPeers(state),
    onDiscovery: (handler) => onDiscovery(state, handler),
    onConnection: (handler) => onConnection(state, handler),
    onMessage: (handler) => onMessage(state, handler),
  };
}
