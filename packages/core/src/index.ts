export { Node } from './node';
export { Pool } from './connection';
export { Orchestrator } from './orchestrator';
export { Matcher } from './capability-matcher';
export { Auth } from './auth';
export { Registry } from './registry-client';
export { Config } from './config';
export { EventBus } from './events';
export { Resources } from './node/lifecycle';
export {
  makeStateRef,
  getState,
  updateState,
  setState,
  modifyState,
  addPeerRef,
  removePeerRef,
  setCircuitBreakerRef,
  getOrCreateCircuitBreaker,
  setRegistryClientRef,
  setWalletRef,
  getWalletRef,
  setMessageAuthRef,
  setConnectionPoolRef,
  setNodeRef,
  setCapabilityTrackingSetupRef,
  addPeersRef,
  subscribeToTopicRef,
} from './node/state-ref';
export {
  withRetry,
  withTimeout,
  sleepEffect,
  withTimeoutEffect,
  waitForEffect,
  CircuitBreaker,
  RateLimiter,
  sleep,
  waitFor,
  defer,
  lazy,
  lazyAsync,
  memoize,
  AsyncQueue,
  FIFOQueue,
  debounce,
  throttle,
} from './util';
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
export { Wallet } from './services/wallet';
export * from './errors';

// Effect-based services
export {
  AuthService,
  MatcherService,
  RegistryService,
  CircuitBreakerService,
  WalletService,
  AuthServiceLive,
  MatcherServiceLive,
  RegistryServiceLive,
  CircuitBreakerServiceLive,
  WalletServiceLive,
  ServicesLive,
  type RegistryClientConfig,
  type RegistryClientState,
  type WalletConfig,
  type WalletState,
} from './services';

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
