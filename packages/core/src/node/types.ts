import type { Libp2p } from 'libp2p';
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
import type { AuthState } from '../services/auth';
import type { PoolState } from '../connection';
import type { ClientState as RegistryClientState } from '../registry-client';
import type { WalletState } from '../services/wallet';
import type { EccoEvent } from '../events';
import type { KadDHT } from '@libp2p/kad-dht';
import type { GossipSub } from '@libp2p/gossipsub';
import type { PeerPerformanceState } from './peer-performance';

export type StateRef<T> = { current: T };

export type EventHandler = (event: EccoEvent) => void;

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
  peers: Record<string, PeerInfo>;
  subscriptions: Record<string, EventHandler[]>;
  messageAuth?: AuthState;
  connectionPool?: PoolState;
  registryClient?: RegistryClientState;
  wallet?: WalletState;
  capabilityTrackingSetup: boolean;
  performanceTracker?: PeerPerformanceState;
  paymentLedger: Record<string, PaymentLedgerEntry>;
  streamingChannels: Record<string, StreamingAgreement>;
  escrowAgreements: Record<string, EscrowAgreement>;
  stakePositions: Record<string, StakePosition>;
  swarmSplits: Record<string, SwarmSplit>;
  pendingSettlements: SettlementIntent[];
}
