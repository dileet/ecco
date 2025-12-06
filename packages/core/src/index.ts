export {
  createAgent as createBaseAgent,
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
  getMultiaddrs,
  getId,
  getLibp2pPeerId,
  isRegistryConnected,
  setRegistryReputation,
  incrementRegistryReputation,
  broadcastCapabilities,
  addPeer,
  removePeer,
  updatePeer,
  addPeers,
  getPeer,
  hasPeer,
  getAllPeers,
  getPeerCount,
  evictStalePeers,
  type StateRef,
  type EccoNode,
  type Agent as BaseAgent,
  type AgentCallbacks,
  type MessageContext as BaseMessageContext,
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
export { getVersion, modifyState, registerCleanup } from './node/state';
export { aggregateResponses, type AggregationResult } from './orchestrator/aggregation';
export {
  createWalletState,
  getPublicClient,
  getWalletClient,
  getAddress,
  pay,
  verifyPayment,
  batchSettle,
  type WalletConfig,
  type WalletState,
  type BatchSettlementResult,
} from './services/wallet';
export {
  validateInvoice,
  recordStreamingTick,
  releaseEscrowMilestone,
  createSwarmSplit,
  distributeSwarmSplit,
  aggregateInvoices,
  type AggregatedInvoice,
} from './services/payment';

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
  setupEmbeddingProvider,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type EmbeddingProviderConfig,
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
  MemoryLimitsConfig,
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
  createLRUCache,
  cloneLRUCache,
  fromRecord,
  type RetryOptions,
  type LRUCache,
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

export {
  createAgent,
  extractPromptText,
  createLLMHandler,
  isAgentRequest,
  createPaymentHelpers,
  createPaymentState,
  type Agent,
  type AgentConfig,
  type MessageContext,
  type PaymentHelpers,
  type PricingConfig,
  type ConsensusRequestOptions,
  type ConsensusResult,
  type GenerateFn,
  type StreamGenerateFn,
  type EmbedFn,
  type AgentEmbeddingConfig,
  type NetworkOption,
  type NetworkQueryConfig,
  type StreamChunk,
  type QueryConfig,
  type DiscoveryOptions,
  type DiscoveryPriority,
  type PeerScoringConfig,
  type PriorityDiscoveryConfig,
} from './agent';
