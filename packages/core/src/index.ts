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
