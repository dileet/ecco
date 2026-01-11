import type { Libp2p } from 'libp2p';
import type { PrivateKey } from '@libp2p/interface';
import type {
  Capability,
  EccoConfig,
  PeerInfo,
  PaymentLedgerEntry,
  StreamingAgreement,
  EscrowAgreement,
  StakePosition,
  SwarmSplit,
  SettlementIntent,
  ProtocolVersion,
} from '../types';
import type { AuthState } from '../auth/authenticator';
import type { PoolState } from './connection-types';
import type { WalletState } from '../payments/wallet';
import type { EccoEvent } from '../events';
import type { KadDHT } from '@libp2p/kad-dht';
import type { GossipSub } from '@libp2p/gossipsub';
import type { PeerPerformanceState } from '../reputation/peer-performance';
import type { HybridDiscoveryState } from './hybrid-discovery';
import type { MessageBridgeState } from './message-bridge';
import type { LRUCache } from '../utils/lru-cache';
import type { MessageDeduplicator, RateLimiter } from '../utils/bloom-filter';
import type { BloomFilterState } from '../reputation/reputation-filter';
import type { ReputationState } from '../reputation/reputation-state';
import type { LatencyZoneState } from '../reputation/latency-zones';

export type StateRef<T> = { 
  current: T;
  version: number;
};

export type EventHandler = (event: EccoEvent) => void;

export interface EccoServices extends Record<string, unknown> {
  identify: unknown;
  ping: unknown;
  dht?: KadDHT;
  pubsub?: GossipSub;
}

export type EccoLibp2p = Libp2p<EccoServices>;

export type CleanupHandler = () => void | Promise<void>;

export interface MessageFloodProtection {
  deduplicator: MessageDeduplicator;
  rateLimiter: RateLimiter;
  topicSubscribers: Map<string, Set<string>>;
}

export interface NodeState {
  id: string;
  libp2pPeerId?: string;
  libp2pPrivateKey?: PrivateKey;
  shuttingDown: boolean;
  config: EccoConfig;
  node: EccoLibp2p | null;
  capabilities: Capability[];
  peers: LRUCache<string, PeerInfo>;
  subscriptions: Record<string, EventHandler[]>;
  subscribedTopics: Map<string, Set<string>>;
  cleanupHandlers: CleanupHandler[];
  messageAuth?: AuthState;
  connectionPool?: PoolState;
  wallet?: WalletState;
  capabilityTrackingSetup: boolean;
  performanceTracker?: PeerPerformanceState;
  paymentLedger: Record<string, PaymentLedgerEntry>;
  streamingChannels: Record<string, StreamingAgreement>;
  escrowAgreements: Record<string, EscrowAgreement>;
  stakePositions: Record<string, StakePosition>;
  swarmSplits: Record<string, SwarmSplit>;
  pendingSettlements: SettlementIntent[];
  transport?: HybridDiscoveryState;
  messageBridge?: MessageBridgeState;
  floodProtection: MessageFloodProtection;
  protocolVersion: ProtocolVersion;
  versionValidatedPeers: Set<string>;
  bloomFilters?: BloomFilterState;
  reputationState?: ReputationState;
  latencyZones?: LatencyZoneState;
}
