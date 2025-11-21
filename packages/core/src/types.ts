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
  | 'payment-failed';

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
