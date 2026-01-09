export {
  type EscrowMilestone,
  type EscrowAgreement,
  type PaymentLedgerEntry,
  type StreamingAgreement,
  type StakePosition,
  type SwarmParticipant,
  type SwarmSplit,
  type SettlementIntent,
  type StoredInvoice,
  type TimedOutPayment,
  type ExpectedInvoice,
} from './storage/schema';

export type DiscoveryMethod =
  | 'mdns'
  | 'dht'
  | 'gossip'
  | 'bluetooth';

export interface MemoryLimitsConfig {
  maxPeers?: number;
  maxSubscriptionsPerTopic?: number;
  peerEvictionPolicy?: 'lru' | 'oldest' | 'lowest-reputation';
  stalePeerTimeoutMs?: number;
}

export interface FloodProtectionConfig {
  dedupMaxMessages?: number;
  dedupFalsePositiveRate?: number;
  rateLimitMaxTokens?: number;
  rateLimitRefillRate?: number;
  rateLimitRefillIntervalMs?: number;
}

export interface EccoConfig {
  discovery: DiscoveryMethod[];
  nodeId?: string;
  networkId?: string;
  listenAddresses?: string[];
  capabilities?: Capability[];
  transport?: TransportConfig;
  bootstrap?: BootstrapConfig;
  proximity?: ProximityConfig;
  memoryLimits?: MemoryLimitsConfig;
  floodProtection?: FloodProtectionConfig;
  protocol?: ProtocolConfig;
  constitution?: Constitution;
  authentication?: {
    enabled: boolean;
    keyPath?: string;
    keyPassword?: string;
    walletRpcUrls?: Record<number, string>;
  };
  retry?: {
    maxAttempts?: number;
    initialDelay?: number;
    maxDelay?: number;
  };
  connectionPool?: {
    maxConnectionsPerPeer?: number;
    maxIdleTime?: number;
  };
}

export interface BootstrapConfig {
  enabled: boolean;
  peers?: string[];
  timeout?: number;
  minPeers?: number;
}

export interface ProximityConfig {
  bluetooth?: {
    enabled: boolean;
    advertise?: boolean;
    scan?: boolean;
    serviceUUID?: string;
  };
  autoConnect?: boolean;
  signalThreshold?: number;
  localContext?: {
    locationId?: string;
    locationName?: string;
    capabilities?: string[];
    metadata?: Record<string, unknown>;
  };
}

export interface TransportConfig {
  websocket?: {
    enabled: boolean;
    port?: number;
  };
}

export interface Capability {
  [key: string]: unknown;
  type: string;
  name: string;
  version: string;
  metadata?: Record<string, unknown>;
}

export interface AgentCapability extends Capability {
  type: 'agent';
  provider: string;
  model?: string;
  features: string[];
}

export interface EmbeddingCapability extends Capability {
  type: 'embedding';
  provider: string;
  model?: string;
  dimensions?: number;
}

export interface ModelCapability extends Capability {
  type: 'model';
  modelType: 'text-generation' | 'embedding' | 'both';
  modelName: string;
  contextLength?: number;
  quantization?: string;
}

export interface PeerInfo {
  id: string;
  addresses: string[];
  capabilities: Capability[];
  lastSeen: number;
  servicesProvided?: number;
  servicesConsumed?: number;
  reputation?: number;
  walletAddress?: `0x${string}`;
  onChainReputation?: {
    score: bigint;
    stake: bigint;
    canWork: boolean;
  };
}

export interface Message {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  payload: unknown;
  timestamp: number;
  signature?: string;
  publicKey?: string;
}

export type MessageType =
  | 'capability-query'
  | 'capability-response'
  | 'agent-request'
  | 'agent-response'
  | 'embedding-request'
  | 'embedding-response'
  | 'generation-request'
  | 'generation-response'
  | 'generation-stream-chunk'
  | 'generation-stream-complete'
  | 'gossip'
  | 'ping'
  | 'pong'
  | 'request-quote'
  | 'invoice'
  | 'submit-payment-proof'
  | 'payment-verified'
  | 'payment-failed'
  | 'streaming-tick'
  | 'stream-chunk'
  | 'stream-complete'
  | 'escrow-approval'
  | 'stake-confirmation'
  | 'swarm-distribution'
  | 'version-handshake'
  | 'version-handshake-response'
  | 'version-incompatible-notice'
  | 'constitution-mismatch-notice';

export interface CapabilityQuery {
  requiredCapabilities: Partial<Capability>[];
  preferredPeers?: string[];
}

export interface CapabilityMatch {
  peer: PeerInfo;
  matchScore: number;
  matchedCapabilities: Capability[];
}

export interface Pricing {
  chainId: number;
  token: string;
  amount: string;
}

export interface Invoice {
  id: string;
  jobId: string;
  chainId: number;
  amount: string;
  token: string;
  tokenAddress: `0x${string}` | null;
  recipient: string;
  validUntil: number;
  signature: string | null;
  publicKey: string | null;
}

export interface SignedInvoice extends Invoice {
  signature: string;
  publicKey: string;
}

export interface PaymentProof {
  invoiceId: string;
  txHash: string;
  chainId: number;
}

export interface QuoteRequest {
  jobType: string;
  jobParams: Record<string, unknown>;
  preferredChains?: number[];
}

export interface StakeRequirement {
  id: string;
  jobId: string;
  chainId: number;
  token: string;
  amount: string;
  slashingCondition: string;
  verifier?: string;
}

export interface ProtocolVersion {
  major: number;
  minor: number;
  patch: number;
}

export type VersionEnforcementLevel = 'strict' | 'warn' | 'none';

export interface ProtocolConfig {
  currentVersion: ProtocolVersion;
  minVersion: ProtocolVersion;
  enforcementLevel: VersionEnforcementLevel;
  upgradeUrl?: string;
}

export interface Constitution {
  rules: string[];
}

export interface ConstitutionHash {
  hash: string;
  rulesCount: number;
}

export interface VersionHandshakePayload {
  protocolVersion: ProtocolVersion;
  networkId: string;
  timestamp: number;
  constitutionHash: ConstitutionHash;
}

export interface VersionHandshakeResponse {
  accepted: boolean;
  protocolVersion: ProtocolVersion;
  minProtocolVersion: ProtocolVersion;
  reason?: string;
  upgradeUrl?: string;
  constitutionMismatch?: boolean;
}

export interface VersionIncompatibleNotice {
  requiredMinVersion: ProtocolVersion;
  yourVersion: ProtocolVersion;
  upgradeUrl?: string;
  message: string;
}

export interface ConstitutionMismatchNotice {
  expectedHash: string;
  receivedHash: string;
  message: string;
}
