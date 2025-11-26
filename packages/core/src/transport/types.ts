export type TransportType = 
  | 'libp2p'
  | 'bluetooth-le'
  | 'wifi-direct'
  | 'multipeer'
  | 'nfc'
  | 'webrtc'
  | 'websocket-relay'
  | 'custom';

export type TransportState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface TransportPeer {
  id: string;
  transport: TransportType;
  addresses: string[];
  rssi?: number;
  lastSeen: number;
  metadata?: Record<string, unknown>;
}

export interface TransportMessage {
  id: string;
  from: string;
  to: string;
  data: Uint8Array;
  timestamp: number;
}

export interface TransportDiscoveryEvent {
  type: 'discovered' | 'lost' | 'updated';
  peer: TransportPeer;
}

export interface TransportConnectionEvent {
  type: 'connected' | 'disconnected' | 'error';
  peerId: string;
  transport: TransportType;
  error?: Error;
}

export interface TransportAdapter {
  readonly type: TransportType;
  readonly state: TransportState;
  
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  
  connect(peerId: string): Promise<void>;
  disconnect(peerId: string): Promise<void>;
  
  send(peerId: string, message: TransportMessage): Promise<void>;
  broadcast(message: TransportMessage): Promise<void>;
  
  getConnectedPeers(): TransportPeer[];
  getDiscoveredPeers(): TransportPeer[];
  
  onDiscovery(handler: (event: TransportDiscoveryEvent) => void): () => void;
  onConnection(handler: (event: TransportConnectionEvent) => void): () => void;
  onMessage(handler: (peerId: string, message: TransportMessage) => void): () => void;
}

export interface TransportManagerConfig {
  adapters: TransportType[];
  preferredTransport?: TransportType;
  autoConnect?: boolean;
  discoveryInterval?: number;
  proximityThreshold?: number;
}

export interface ProximityInfo {
  peerId: string;
  transport: TransportType;
  rssi?: number;
  distance?: 'immediate' | 'near' | 'far' | 'unknown';
  lastSeen: number;
}

export interface LocalContext {
  locationId?: string;
  locationName?: string;
  capabilities: string[];
  metadata?: Record<string, unknown>;
}

export interface BeaconConfig {
  uuid: string;
  major: number;
  minor: number;
  localContext?: LocalContext;
}

