export type DiscoveryMethod = 'mdns' | 'dht' | 'gossip' | 'registry';

export interface EccoConfig {
  discovery: DiscoveryMethod[];
  registry?: string;
  fallbackToP2P?: boolean;
  nodeId?: string;
  capabilities?: Capability[];
  transport?: TransportConfig;
  bootstrap?: BootstrapConfig;
  authentication?: {
    enabled: boolean;
    generateKeys?: boolean;
    keyPath?: string;
    walletAutoInit?: boolean;
    walletRpcUrls?: Record<number, string>;
    walletReceiptTimeoutMs?: number;
  };
  retry?: {
    maxAttempts?: number;
    initialDelay?: number;
    maxDelay?: number;
  };
  connectionPool?: {
    maxConnectionsPerPeer?: number;
    maxIdleTime?: number;
    cleanupInterval?: number;
  };
}

export interface BootstrapConfig {
  enabled: boolean;
  peers?: string[];
  timeout?: number;
  minPeers?: number;
}

export interface TransportConfig {
  websocket?: {
    enabled: boolean;
    port?: number;
  };
  webrtc?: {
    enabled: boolean;
  };
}

export interface Capability {
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

export interface PeerInfo {
  id: string;
  addresses: string[];
  capabilities: Capability[];
  lastSeen: number;
  servicesProvided?: number;
  servicesConsumed?: number;
  reputation?: number;
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
  | 'gossip'
  | 'ping'
  | 'pong'
  | 'request-quote'
  | 'invoice'
  | 'submit-payment-proof'
  | 'payment-verified'
  | 'payment-failed'
  | 'streaming-tick'
  | 'escrow-approval'
  | 'stake-confirmation'
  | 'swarm-distribution';

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
  recipient: string;
  validUntil: number;
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

export type PaymentLedgerStatus = 'pending' | 'streaming' | 'settled' | 'slashed' | 'cancelled';

export interface PaymentLedgerEntry {
  id: string;
  type: 'streaming' | 'escrow' | 'stake' | 'swarm' | 'standard';
  status: PaymentLedgerStatus;
  chainId: number;
  token: string;
  amount: string;
  recipient: string;
  payer: string;
  jobId?: string;
  createdAt: number;
  settledAt?: number;
  txHash?: string;
  metadata?: Record<string, unknown>;
}

export interface StreamingAgreement {
  id: string;
  jobId: string;
  payer: string;
  recipient: string;
  chainId: number;
  token: string;
  ratePerToken: string;
  accumulatedAmount: string;
  lastTick: number;
  status: 'active' | 'closed';
  createdAt: number;
  closedAt?: number;
}

export interface EscrowMilestone {
  id: string;
  amount: string;
  released: boolean;
  releasedAt?: number;
  txHash?: string;
}

export interface EscrowAgreement {
  id: string;
  jobId: string;
  payer: string;
  recipient: string;
  chainId: number;
  token: string;
  totalAmount: string;
  milestones: EscrowMilestone[];
  status: 'locked' | 'partially-released' | 'fully-released' | 'cancelled';
  createdAt: number;
  requiresApproval: boolean;
  approver?: string;
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

export interface StakePosition {
  id: string;
  stakeRequirementId: string;
  jobId: string;
  staker: string;
  chainId: number;
  token: string;
  amount: string;
  status: 'locked' | 'released' | 'slashed';
  lockedAt: number;
  releasedAt?: number;
  slashedAt?: number;
  txHash?: string;
  releaseTxHash?: string;
  slashTxHash?: string;
}

export interface SwarmParticipant {
  peerId: string;
  walletAddress: string;
  contribution: number;
  amount: string;
}

export interface SwarmSplit {
  id: string;
  jobId: string;
  payer: string;
  totalAmount: string;
  chainId: number;
  token: string;
  participants: SwarmParticipant[];
  status: 'pending' | 'distributed' | 'failed';
  createdAt: number;
  distributedAt?: number;
}

export interface SettlementIntent {
  id: string;
  type: 'streaming' | 'escrow' | 'stake-release' | 'stake-slash' | 'swarm' | 'standard';
  ledgerEntryId: string;
  invoice?: Invoice;
  priority: number;
  createdAt: number;
  retryCount: number;
  maxRetries: number;
}
