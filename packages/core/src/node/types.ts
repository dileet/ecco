import type { Libp2p } from 'libp2p';
import type { Ref } from 'effect';
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
} from '../types';
import type { MatcherState } from '../orchestrator/capability-matcher';
import type { AuthState } from '../services/auth';
import type { PoolState } from '../connection';
import type { BreakerState } from '../util/circuit-breaker';
import type { ClientState as RegistryClientState } from '../registry-client';
import type { WalletState } from '../services/wallet';
import type { EccoEvent } from '../events';
import type { KadDHT } from '@libp2p/kad-dht';
import type { GossipSub } from '@libp2p/gossipsub';
import type { PeerPerformanceState } from './peer-performance';
import type { BadBehaviorTracker } from './bad-behavior-sketch';

export interface EccoServices extends Record<string, unknown> {
  identify: unknown;
  ping: unknown;
  dht?: KadDHT;
  pubsub?: GossipSub;
}

export type EccoLibp2p = Libp2p<EccoServices>;

export interface NodeState {
  id: string;
  config: EccoConfig;
  node: EccoLibp2p | null;
  capabilities: Capability[];
  peers: Map<string, PeerInfo>;
  subscriptions: Map<string, Set<(event: EccoEvent) => void>>;
  capabilityMatcher: MatcherState;
  messageAuth?: AuthState;
  connectionPool?: PoolState;
  circuitBreakers: Map<string, BreakerState>;
  registryClientRef?: Ref.Ref<RegistryClientState>;
  walletRef?: Ref.Ref<WalletState>;
  capabilityTrackingSetup: boolean;
  performanceTracker?: Ref.Ref<PeerPerformanceState>;
  badBehaviorTracker?: BadBehaviorTracker;
  paymentLedger: Map<string, PaymentLedgerEntry>;
  streamingChannels: Map<string, StreamingAgreement>;
  escrowAgreements: Map<string, EscrowAgreement>;
  stakePositions: Map<string, StakePosition>;
  swarmSplits: Map<string, SwarmSplit>;
  pendingSettlements: SettlementIntent[];
  _ref?: Ref.Ref<NodeState>;
}
