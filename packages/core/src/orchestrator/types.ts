import type { PeerInfo } from '../types';
import type { NodeState, StateRef } from '../node/types';
import type { EmbedFn } from '../agent/types';

export type SelectionStrategy =
  | 'all'
  | 'top-n'
  | 'round-robin'
  | 'random'
  | 'weighted';

export type AggregationStrategy =
  | 'majority-vote'
  | 'weighted-vote'
  | 'best-score'
  | 'ensemble'
  | 'consensus-threshold'
  | 'first-response'
  | 'longest'
  | 'synthesized-consensus'
  | 'custom';

export type SynthesizeFn = (
  query: string,
  responses: AgentResponse[]
) => Promise<string>;

export interface MultiAgentConfig {
  selectionStrategy: SelectionStrategy;
  agentCount?: number;
  aggregationStrategy: AggregationStrategy;
  minAgents?: number;
  consensusThreshold?: number;
  timeout?: number;
  allowPartialResults?: boolean;
  customAggregator?: (responses: AgentResponse[]) => AggregatedResult;
  loadBalancing?: LoadBalancingConfig;
  semanticSimilarity?: SemanticSimilarityConfig;
  zoneSelection?: ZoneSelectionConfig;
  stakeRequirement?: StakeRequirementConfig;
  nodeRef?: StateRef<NodeState>;
  onStream?: (chunk: { text: string; peerId: string }) => void;
  synthesizeFn?: SynthesizeFn;
  originalQuery?: string;
}

export interface SemanticSimilarityConfig {
  enabled: boolean;
  method?: 'text-overlap' | 'local-embedding' | 'openai-embedding' | 'peer-embedding' | 'custom';
  threshold?: number;
  openaiApiKey?: string;
  embeddingModel?: string;
  requireExchange?: boolean;
  customSimilarityFn?: (text1: string, text2: string) => Promise<number>;
  localEmbedFn?: EmbedFn;
}

export interface LoadBalancingConfig {
  enabled: boolean;
  trackRequestCounts?: boolean;
  preferLessLoaded?: boolean;
  maxConcurrentPerAgent?: number;
  loadWeight?: number;
}

export interface ZoneSelectionConfig {
  preferredZone?: 'local' | 'regional' | 'continental' | 'global';
  maxZone?: 'local' | 'regional' | 'continental' | 'global';
  zoneFallbackTimeout?: number;
  ignoreLatency?: boolean;
}

export interface StakeRequirementConfig {
  requireStake?: boolean;
  minStake?: bigint;
  preferStaked?: boolean;
  stakedBonus?: number;
}

export interface AgentResponse {
  peer: PeerInfo;
  matchScore: number;
  response: unknown;
  timestamp: number;
  latency: number;
  error?: Error;
  success: boolean;
}

export interface AggregatedResult {
  result: unknown;
  responses: AgentResponse[];
  consensus: {
    achieved: boolean;
    confidence: number;
    agreement: number;
    strategy: AggregationStrategy;
  };
  metrics: {
    totalAgents: number;
    successfulAgents: number;
    failedAgents: number;
    averageLatency: number;
    totalTime: number;
  };
  rankings?: {
    peer: PeerInfo;
    score: number;
    contribution: number;
  }[];
}

export interface AgentLoadState {
  peerId: string;
  activeRequests: number;
  totalRequests: number;
  totalErrors: number;
  averageLatency: number;
  lastRequestTime: number;
  successRate: number;
}
