export { Node } from './node';
export { Pool } from './connection';
export { Orchestrator } from './orchestrator';
export { Matcher } from './orchestrator/capability-matcher';
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
export { configDefaults, mergeConfig } from './config';
export { validateEvent, isValidEvent } from './events';
export { Resources } from './node/lifecycle';
export {
  makeStateRef,
  getState,
  updateState,
  setState,
  modifyState,
  addPeerRef,
  removePeerRef,
  setRegistryClientRef,
  setWalletRef,
  getWalletRef,
  setMessageAuthRef,
  setConnectionPoolRef,
  setNodeRef,
  setCapabilityTrackingSetupRef,
  addPeersRef,
  subscribeToTopicRef,
  addPaymentLedgerEntryRef,
  updatePaymentLedgerEntryRef,
  setStreamingChannelRef,
  updateStreamingChannelRef,
  setEscrowAgreementRef,
  updateEscrowAgreementRef,
  setStakePositionRef,
  updateStakePositionRef,
  setSwarmSplitRef,
  updateSwarmSplitRef,
  enqueueSettlementRef,
  dequeueSettlementRef,
  removeSettlementRef,
  updateSettlementRef,
  setStreamingChannel,
  updateStreamingChannel,
  setEscrowAgreement,
  updateEscrowAgreement,
  setSwarmSplit,
  updateSwarmSplit,
  addPaymentLedgerEntry,
  enqueueSettlement,
  getNodeState,
} from './node/state-ref';
export { SelectionStrategy } from './orchestrator/selection';
export { AggregationStrategy } from './orchestrator/aggregation';
export { LoadBalancing } from './orchestrator/load-balancing';
export {
  EmbeddingService,
  isEmbeddingRequest,
  isEmbeddingResponse,
  type EmbeddingRequest,
  type EmbeddingResponse,
} from './services/embedding';
export { PaymentProtocol } from './services/payment';
export {
  Wallet,
  WalletService,
  WalletServiceLive,
  type WalletConfig,
  type WalletState,
} from './services/wallet';

export {
  StorageService,
  StorageServiceLive,
  StorageError,
  type StorageService as StorageServiceType,
} from './storage';

export {
  type ClientState as RegistryClientState,
} from './registry-client';

export {
  type MatcherState,
  type MatchWeights,
} from './orchestrator/capability-matcher';

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
export type { NodeCreationError } from './node/lifecycle';
export type { PoolState } from './connection';
export type { OrchestratorState } from './orchestrator';

export type {
  MultiAgentConfig,
  AggregatedResult,
  AgentResponse,
  SelectionStrategy as SelectionStrategyType,
  AggregationStrategy as AggregationStrategyType,
  LoadBalancingConfig,
  AgentLoadState,
  Vote,
  MultiAgentRequestState,
  SemanticSimilarityConfig,
} from './orchestrator/types';
