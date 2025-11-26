export { Node } from './node';
export { Pool } from './connection';
export { Orchestrator } from './orchestrator';
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
  setEscrowAgreement,
  setSwarmSplit,
  addPaymentLedgerEntry,
  enqueueSettlement,
  getNodeState,
} from './node/state-ref';
export { SelectionStrategy } from './orchestrator/selection';
export { aggregateResponses, type AggregationResult } from './orchestrator/aggregation';
export { LoadBalancing } from './orchestrator/load-balancing';
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
  AgentResponse,
  SelectionStrategy as SelectionStrategyType,
  AggregationStrategy as AggregationStrategyType,
  LoadBalancingConfig,
  AgentLoadState,
  Vote,
  MultiAgentRequestState,
  SemanticSimilarityConfig,
} from './orchestrator/types';
