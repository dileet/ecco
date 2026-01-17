import type {
  Capability,
  CapabilityMatch,
  CapabilityQuery,
  Invoice,
  Message,
  MessageType,
  PaymentProof,
  PeerInfo,
  ProtocolVersion,
} from '../types'
import type { StakeInfo } from '../identity'
import type { NodeState, StateRef } from '../networking/types'
import type { WalletState } from '../payments/wallet'
import type { LocalModelState } from '../llm/local-model'
import type {
  MultiAgentConfig,
  AgentResponse,
  AggregatedResult,
  SelectionStrategy,
  SemanticSimilarityConfig,
  LoadBalancingConfig,
} from '../orchestrator/types'

export type NetworkOption = 'testnet' | 'mainnet'

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

export interface BluetoothTransportConfig {
  enabled: boolean
  role?: 'central' | 'peripheral' | 'both'
  serviceUUID?: string
  localName?: string
}

export interface TransportsConfig {
  bluetooth?: BluetoothTransportConfig
}

export interface PricingConfig {
  type: 'streaming' | 'escrow' | 'swarm'
  chainId: number
  token?: string
  amount?: string | bigint
  ratePerToken?: string | bigint
  milestones?: Array<{ id: string; description: string; amount: string | bigint }>
  participants?: Array<{ agentId: string; share: number }>
  requiresApproval?: boolean
  approver?: string
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
  tokens?: number
  peerId?: string
}

export interface MessageContext {
  agent: Agent
  message: Message
  reply: (payload: unknown, type?: MessageType) => Promise<void>
  streamResponse: (generator: AsyncGenerator<StreamChunk> | (() => AsyncGenerator<StreamChunk>)) => Promise<void>
}

export type MessageHandler = (msg: Message, ctx: MessageContext) => Promise<void>

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

export interface WorkRewardOptions {
  difficulty?: number
  consensusAchieved?: boolean
  fastResponse?: boolean
}

export interface WorkRewardResult {
  txHash: string
  estimatedReward: bigint
}

export interface FeeCalculation {
  feePercent: number
  feeAmount: bigint
  netAmount: bigint
  isEccoDiscount: boolean
}

export interface PayWithFeeResult {
  paymentHash: string
  feeHash: string
  feeAmount: bigint
  netAmount: bigint
}

export interface FeeHelpers {
  calculateFee: (chainId: number, amount: bigint) => Promise<FeeCalculation>
  payWithFee: (chainId: number, recipient: `0x${string}`, amount: bigint) => Promise<PayWithFeeResult>
  collectFeeWithEcco: (chainId: number, payee: `0x${string}`, amount: bigint) => Promise<string>
  claimRewards: (chainId: number) => Promise<string>
  getPendingRewards: (chainId: number) => Promise<{ ethPending: bigint; eccoPending: bigint }>
}

export interface PaymentHelpers {
  requirePayment: (ctx: MessageContext, pricing: PricingConfig, options?: { signal?: AbortSignal }) => Promise<PaymentProof>
  createInvoice: (ctx: MessageContext, pricing: PricingConfig) => Promise<Invoice>
  verifyPayment: (proof: PaymentProof) => Promise<boolean>
  releaseMilestone: (ctx: MessageContext, milestoneId: string, options?: ReleaseMilestoneOptions) => Promise<void>
  sendEscrowInvoice: (ctx: MessageContext) => Promise<void>
  recordTokens: (ctx: MessageContext, count: number, options?: RecordTokensOptions) => Promise<RecordTokensResult>
  sendStreamingInvoice: (ctx: MessageContext, channelId: string) => Promise<void>
  closeStreamingChannel: (channelId: string) => Promise<void>
  distributeToSwarm: (jobId: string, options: DistributeToSwarmOptions) => Promise<DistributeToSwarmResult>
  queueInvoice: (invoice: Invoice) => void
  settleAll: () => Promise<BatchSettlementResult[]>
  getPendingInvoices: () => Invoice[]
  rewardPeer: (jobId: string, peerAddress: string, chainId: number, options?: WorkRewardOptions) => Promise<WorkRewardResult | null>
}

export interface LocalModelConfig {
  modelPath: string
  contextSize?: number
  gpuLayers?: number
  threads?: number
  supportsEmbedding?: boolean
  modelName?: string
}

export interface AgentReputationConfig {
  chainId?: number
  commitThreshold?: number
  syncIntervalMs?: number
}

export interface AgentConfig {
  name: string
  network?: NetworkOption
  bootstrap?: string[]
  capabilities: Capability[]
  handler?: (msg: Message, ctx: MessageContext) => Promise<void>
  systemPrompt?: string
  model?: unknown
  generateFn?: GenerateFn
  streamGenerateFn?: StreamGenerateFn
  wallet?: AgentWalletConfig
  pricing?: PricingConfig
  embedding?: AgentEmbeddingConfig | LocalModelState
  transports?: TransportsConfig
  localModel?: LocalModelConfig
  reputation?: AgentReputationConfig
}

export interface ConsensusRequestOptions {
  query: string
  config?: Partial<MultiAgentConfig>
  capabilityQuery?: CapabilityQuery
  additionalResponses?: AgentResponse[]
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

export interface FindPeersOptions extends CapabilityQuery {
  minStake?: bigint
  requireStake?: boolean
}

export interface Agent {
  id: string
  addrs: string[]
  ref: StateRef<NodeState>
  wallet: WalletState | null
  address: string | null
  chainId: number
  capabilities: Capability[]
  payments: PaymentHelpers
  fees: FeeHelpers | null
  hasEmbedding: boolean
  protocolVersion: ProtocolVersion
  embed: ((texts: string[]) => Promise<number[][]>) | null
  findPeers: (query?: FindPeersOptions) => Promise<CapabilityMatch[]>
  request: (peerId: string, prompt: string, options?: { signal?: AbortSignal }) => Promise<AgentResponse>
  requestConsensus: (options: ConsensusRequestOptions) => Promise<ConsensusResult>
  send: (peerId: string, type: MessageType, payload: unknown) => Promise<void>
  stop: () => Promise<void>
  query: (prompt: string, config?: QueryConfig) => Promise<ConsensusResult>
  onChainAgentId: bigint | null
  register: (agentURI?: string) => Promise<bigint>
  stake: (amount: bigint) => Promise<string>
  unstake: (amount: bigint) => Promise<string>
  getStakeInfo: () => Promise<StakeInfo>
  resolveWalletForPeer: (peerId: string) => Promise<`0x${string}` | null>
}

interface BaseNetworkQueryConfig {
  selectionStrategy?: SelectionStrategy
  consensusThreshold?: number
  timeout?: number
  allowPartialResults?: boolean
  agentCount?: number
  minAgents?: number
  loadBalancing?: LoadBalancingConfig
}

interface SemanticAggregationConfig extends BaseNetworkQueryConfig {
  aggregationStrategy?: 'consensus-threshold' | 'majority-vote'
  semanticSimilarity?: SemanticSimilarityConfig
}

interface NonSemanticAggregationConfig extends BaseNetworkQueryConfig {
  aggregationStrategy: 'best-score' | 'ensemble' | 'weighted-vote' | 'first-response' | 'longest' | 'custom'
  semanticSimilarity?: never
}

interface SynthesizedConsensusConfig extends BaseNetworkQueryConfig {
  aggregationStrategy: 'synthesized-consensus'
  synthesizeFn?: (query: string, responses: AgentResponse[]) => Promise<string>
  semanticSimilarity?: SemanticSimilarityConfig
}

export type NetworkQueryConfig = SemanticAggregationConfig | NonSemanticAggregationConfig | SynthesizedConsensusConfig

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

interface QueryConfigExtras {
  discovery?: DiscoveryOptions
  peerScoring?: PeerScoringConfig
  includeSelf?: boolean
  systemPrompt?: string
  onStream?: (chunk: StreamChunk) => void
}

export type QueryConfig = NetworkQueryConfig & QueryConfigExtras

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
