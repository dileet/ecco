export type {
  TransportType,
  TransportState,
  TransportPeer,
  TransportMessage,
  TransportDiscoveryEvent,
  TransportConnectionEvent,
  TransportAdapter,
  TransportManagerConfig,
  ProximityInfo,
  LocalContext,
  BeaconConfig,
} from './types';

export {
  createTransportManager,
  registerAdapter,
  initializeAdapters,
  startDiscovery,
  getProximityPeers,
  connectToPeer,
  sendMessage,
  broadcastMessage,
  shutdown,
  getBestTransportForPeer,
  type TransportManagerState,
} from './manager';

export {
  createHybridDiscovery,
  registerAdapter as registerHybridAdapter,
  setPhaseMapping,
  startDiscovery as startHybridDiscovery,
  stopDiscovery as stopHybridDiscovery,
  connectWithFallback,
  sendWithFallback,
  getDiscoveredPeers as getHybridDiscoveredPeers,
  getProximityPeers as getHybridProximityPeers,
  getPeersByPhase,
  onDiscovery as onHybridDiscovery,
  onConnection as onHybridConnection,
  onMessage as onHybridMessage,
  onPhaseChange,
  getCurrentPhase,
  forcePhase,
  getTransportStats,
  type HybridDiscoveryConfig,
  type HybridDiscoveryState,
  type DiscoveryPhase,
  type DiscoveryResult,
} from './hybrid-discovery';

export * as bleAdapter from './adapters/bluetooth-le';
export * as libp2pAdapter from './adapters/libp2p';
export * as webrtcAdapter from './adapters/webrtc';

export type { BLENativeBridge, BLEAdapterConfig } from './adapters/bluetooth-le';
export type { Libp2pAdapterConfig } from './adapters/libp2p';
export type { WebRTCAdapterConfig, RTCIceServer } from './adapters/webrtc';

export {
  createMessageBridge,
  setAuthState,
  serializeMessage,
  deserializeMessage,
  createMessage,
  subscribeToTopic,
  unsubscribeFromTopic,
  subscribeToDirectMessages,
  subscribeToAllDirectMessages,
  handleIncomingTransportMessage,
  serializeTopicMessage,
  handleIncomingBroadcast,
  getSubscribedTopics,
  type MessageBridgeConfig,
  type MessageBridgeState,
  type TopicMessage,
} from './message-bridge';

