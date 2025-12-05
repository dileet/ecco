import type {
  Capability,
  CapabilityMatch,
  CapabilityQuery,
  DiscoveryMethod,
  Invoice,
  Message,
  MessageType,
  PaymentProof,
  PeerInfo,
} from '../types'
import type { NodeState, StateRef } from '../node/types'
import type { WalletState } from '../services/wallet'
import type {
  MultiAgentConfig,
  AgentResponse,
  AggregatedResult,
  SelectionStrategy,
  AggregationStrategy,
  SemanticSimilarityConfig,
  LoadBalancingConfig,
} from '../orchestrator/types'

export type NetworkOption = 'testnet' | 'mainnet' | string[]

export type GenerateFn = (options: {
  model: unknown
  system: string
  prompt: string
}) => Promise<{ text: string }>

export type StreamGenerateFn = (options: {
  model: unknown
  system: string
  prompt: string
}) => AsyncGenerator<{ text: string; tokens?: number }>

export type EmbedFn = (texts: string[]) => Promise<number[][]>

export interface AgentWalletConfig {
  privateKey?: string
  rpcUrls?: Record<number, string>
}

export interface AgentEmbeddingConfig {
  modelId: string
  embedFn: EmbedFn
}

export interface PricingConfig {
  type: 'streaming' | 'escrow' | 'swarm'
  chainId: number
  token?: string
  amount?: string | bigint
  ratePerToken?: string | bigint
  milestones?: Array<{ id: string; description: string; amount: string | bigint }>
  participants?: Array<{ agentId: string; share: number }>
}

export interface RecordTokensOptions {
  channelId?: string
  pricing?: PricingConfig
  autoInvoice?: boolean
}

export interface ReleaseMilestoneOptions {
  sendInvoice?: boolean
}

export interface RecordTokensResult {
  channelId: string
  tokens: number
  totalTokens: number
  amountOwed: string
  totalAmount: string
  invoiceSent: boolean
}

export interface StreamChunk {
  text: string
  tokens: number
}

export interface MessageContext {
  agent: Agent
  message: Message
  reply: (payload: unknown, type?: MessageType) => Promise<void>
  streamResponse: (generator: AsyncGenerator<StreamChunk> | (() => AsyncGenerator<StreamChunk>)) => Promise<void>
}

export interface BatchSettlementResult {
  aggregatedInvoice: {
    recipient: string
    chainId: number
    token: string
    totalAmount: string
    invoiceIds: string[]
    jobIds: string[]
  }
  txHash: string
  success: boolean
  error?: string
}

export interface SwarmParticipantInput {
  peerId: string
  walletAddress: string
  contribution: number
}

export interface DistributeToSwarmOptions {
  totalAmount: string
  chainId: number
  token?: string
  participants: SwarmParticipantInput[]
}

export interface DistributeToSwarmResult {
  splitId: string
  invoicesSent: number
  totalAmount: string
}

export interface PaymentHelpers {
  requirePayment: (ctx: MessageContext, pricing: PricingConfig) => Promise<PaymentProof>
  createInvoice: (ctx: MessageContext, pricing: PricingConfig) => Promise<Invoice>
  verifyPayment: (proof: PaymentProof) => Promise<boolean>
  releaseMilestone: (ctx: MessageContext, milestoneId: string, options?: ReleaseMilestoneOptions) => Promise<void>
  sendEscrowInvoice: (ctx: MessageContext) => Promise<void>
  recordTokens: (ctx: MessageContext, count: number, options?: RecordTokensOptions) => Promise<RecordTokensResult>
  sendStreamingInvoice: (ctx: MessageContext, channelId: string) => Promise<void>
  distributeToSwarm: (jobId: string, options: DistributeToSwarmOptions) => Promise<DistributeToSwarmResult>
  queueInvoice: (invoice: Invoice) => void
  settleAll: () => Promise<BatchSettlementResult[]>
  getPendingInvoices: () => Invoice[]
}

export interface AgentConfig {
  name: string
  network?: NetworkOption
  capabilities: Capability[]
  handler?: (msg: Message, ctx: MessageContext) => Promise<void>
  personality?: string
  model?: unknown
  generateFn?: GenerateFn
  streamGenerateFn?: StreamGenerateFn
  wallet?: AgentWalletConfig
  discovery?: DiscoveryMethod[]
  pricing?: PricingConfig
}

export interface ConsensusRequestOptions {
  query: string
  config?: Partial<MultiAgentConfig>
  capabilityQuery?: CapabilityQuery
}

export interface ConsensusResult {
  text: string
  consensus: {
    achieved: boolean
    confidence: number
  }
  metrics: {
    totalAgents: number
    successfulAgents: number
    averageLatency: number
  }
  agentResponses: AgentResponse[]
  raw: AggregatedResult
}

export interface Agent {
  id: string
  addrs: string[]
  ref: StateRef<NodeState>
  wallet: WalletState | null
  address: string | null
  capabilities: Capability[]
  payments: PaymentHelpers
  findPeers: (query?: CapabilityQuery) => Promise<CapabilityMatch[]>
  request: (peerId: string, prompt: string) => Promise<AgentResponse>
  requestConsensus: (options: ConsensusRequestOptions) => Promise<ConsensusResult>
  send: (peerId: string, type: MessageType, payload: unknown) => Promise<void>
  stop: () => Promise<void>
  query: (prompt: string, config?: QueryConfig) => Promise<ConsensusResult>
}

export interface LocalNetworkConfig {
  agents: Agent[]
  embedding?: AgentEmbeddingConfig
  wallet?: AgentWalletConfig
}

export interface NetworkQueryConfig {
  selectionStrategy?: SelectionStrategy
  aggregationStrategy?: AggregationStrategy
  consensusThreshold?: number
  timeout?: number
  allowPartialResults?: boolean
  semanticSimilarity?: SemanticSimilarityConfig
  agentCount?: number
  minAgents?: number
  loadBalancing?: LoadBalancingConfig
}

export interface LocalNetwork {
  agents: Agent[]
  embedding: Agent | null
  query: (prompt: string, config?: NetworkQueryConfig) => Promise<ConsensusResult>
  shutdown: () => Promise<void>
}

export type DiscoveryPriority = 'proximity' | 'local' | 'internet' | 'fallback'

export interface DiscoveryOptions {
  phases?: DiscoveryPriority[]
  phaseTimeout?: number
  preferProximity?: boolean
  minPeers?: number
  capabilityQuery?: CapabilityQuery
}

export interface PeerScoringConfig {
  reputationWeight?: number
  latencyWeight?: number
  proximityBonus?: number
}

export interface QueryConfig extends NetworkQueryConfig {
  discovery?: DiscoveryOptions
  peerScoring?: PeerScoringConfig
}

export interface PriorityDiscoveryConfig {
  phases: DiscoveryPriority[]
  phaseTimeout: number
  minPeers: number
  preferProximity: boolean
}

export interface PriorityPeerInfo extends PeerInfo {
  phase: DiscoveryPriority
  proximityScore?: number
}
