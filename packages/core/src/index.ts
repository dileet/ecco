export {
  createInitialState,
  createStateRef,
  getState,
  setState,
  updateState,
  start,
  stop,
  publish,
  subscribeToTopic,
  findPeers,
  sendMessage,
  getCapabilities,
  addCapability,
  getPeers,
  getMultiaddrs,
  getId,
  isRegistryConnected,
  setRegistryReputation,
  incrementRegistryReputation,
  type StateRef,
} from './node';
export {
  initialOrchestratorState,
  executeOrchestration,
  getLoadStatistics,
  resetLoadStatistics,
} from './orchestrator';
export {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  exportPrivateKey,
  importPrivateKey,
  signMessage,
  verifyMessage,
  isMessageFresh,
  type AuthConfig,
  type SignedMessage,
  type AuthState,
} from './services/auth';
export {
  connect as registryConnect,
  disconnect as registryDisconnect,
  register as registryRegister,
  unregister as registryUnregister,
  query as registryQuery,
  setReputation as registrySetReputation,
  incrementReputation as registryIncrementReputation,
} from './registry-client';
export { configDefaults, mergeConfig, createConfig } from './config';
export {
  ECCO_MAINNET,
  ECCO_TESTNET,
  ECCO_LOCAL,
  NETWORKS,
  OFFICIAL_BOOTSTRAP_PEERS,
  getNetworkConfig,
  applyNetworkConfig,
  formatBootstrapPeer,
  withBootstrapPeers,
  DEFAULT_NETWORK,
  type NetworkConfig,
  type NetworkName,
} from './networks';
export { validateEvent, isValidEvent, MessageEventSchema } from './events';
export { modifyState } from './node/state';
export { aggregateResponses, type AggregationResult } from './orchestrator/aggregation';
export {
  createWalletState,
  getPublicClient,
  getWalletClient,
  pay,
  verifyPayment,
  type WalletConfig,
  type WalletState,
} from './services/wallet';

export {
  initialize as storageInitialize,
  loadEscrowAgreements,
  loadPaymentLedger,
  loadStreamingChannels,
  loadStakePositions,
  loadSwarmSplits,
  loadPendingSettlements,
  writeEscrowAgreement,
  updateEscrowAgreement,
  writePaymentLedgerEntry,
  updatePaymentLedgerEntry,
  writeStreamingChannel,
  updateStreamingChannel,
  writeStakePosition,
  updateStakePosition,
  writeSwarmSplit,
  updateSwarmSplit,
  writeSettlement,
  removeSettlement,
  updateSettlement,
} from './storage';

export {
  type ClientState as RegistryClientState,
} from './registry-client';

export {
  type MatchWeights,
  DEFAULT_WEIGHTS,
  matchPeers,
} from './orchestrator/capability-matcher';

export {
  EmbeddingRequestSchema,
  EmbeddingResponseSchema,
  updatePeerServiceProvided,
  requestEmbeddings,
  type EmbeddingRequest,
  type EmbeddingResponse,
} from './services/embedding';

export type {
  EccoConfig,
  Capability,
  AgentCapability,
  EmbeddingCapability,
  PeerInfo,
  Message,
  MessageType,
  CapabilityQuery,
  CapabilityMatch,
  DiscoveryMethod,
  TransportConfig,
  ProximityConfig,
  Pricing,
  Invoice,
  PaymentProof,
  QuoteRequest,
  PaymentLedgerStatus,
  PaymentLedgerEntry,
  StreamingAgreement,
  EscrowAgreement,
  EscrowMilestone,
  StakeRequirement,
  StakePosition,
  SwarmSplit,
  SwarmParticipant,
  SettlementIntent,
} from './types';

export type {
  EccoEvent,
  CapabilityAnnouncementEvent,
  CapabilityRequestEvent,
  CapabilityResponseEvent,
  PeerDiscoveredEvent,
  PeerDisconnectedEvent,
  MessageEvent,
} from './events';

export type { NodeState } from './node/types';
export type { PoolState } from './connection';
export type { OrchestratorState } from './orchestrator';

export type {
  MultiAgentConfig,
  AgentResponse,
  AggregatedResult,
  SelectionStrategy as SelectionStrategyType,
  AggregationStrategy as AggregationStrategyType,
  LoadBalancingConfig,
  AgentLoadState,
  SemanticSimilarityConfig,
} from './orchestrator/types';

export {
  delay,
  withTimeout,
  retryWithBackoff,
  type RetryOptions,
} from './utils';

export {
  createHybridDiscovery,
  registerAdapter as registerTransportAdapter,
  setPhaseMapping,
  startDiscovery as startTransportDiscovery,
  stopDiscovery as stopTransportDiscovery,
  connectWithFallback,
  sendWithFallback,
  getDiscoveredPeers as getTransportDiscoveredPeers,
  getProximityPeers as getTransportProximityPeers,
  getPeersByPhase,
  onDiscovery as onTransportDiscovery,
  onConnection as onTransportConnection,
  onMessage as onTransportMessage,
  onPhaseChange,
  getCurrentPhase,
  forcePhase,
  getTransportStats,
  type HybridDiscoveryConfig,
  type HybridDiscoveryState,
  type DiscoveryPhase,
  type DiscoveryResult,
} from './transport/hybrid-discovery';

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
} from './transport/types';

export * as bleAdapter from './transport/adapters/bluetooth-le';
export * as libp2pTransport from './transport/adapters/libp2p';
export * as webrtcTransport from './transport/adapters/webrtc';

export {
  createMessageBridge,
  setAuthState as setMessageBridgeAuth,
  serializeMessage,
  deserializeMessage,
  createMessage,
  subscribeToTopic as bridgeSubscribeToTopic,
  unsubscribeFromTopic as bridgeUnsubscribeFromTopic,
  subscribeToDirectMessages,
  subscribeToAllDirectMessages,
  handleIncomingTransportMessage,
  serializeTopicMessage,
  handleIncomingBroadcast,
  getSubscribedTopics,
  type MessageBridgeConfig,
  type MessageBridgeState,
  type TopicMessage,
} from './transport/message-bridge';
