/**
 * Types for multi-agent consensus and output aggregation
 */

import type { PeerInfo, CapabilityMatch } from '../types';
import type { NodeState } from '../node/types';

/**
 * Strategy for selecting which agents to query
 */
export type SelectionStrategy =
  | 'all'           // Query all matching agents
  | 'top-n'         // Query top N agents by score
  | 'round-robin'   // Distribute queries evenly across agents
  | 'random'        // Random selection from matches
  | 'weighted';     // Weighted random based on score/performance

/**
 * Strategy for aggregating outputs from multiple agents
 */
export type AggregationStrategy =
  | 'majority-vote'      // Most common response wins
  | 'weighted-vote'      // Vote weighted by agent score/performance
  | 'best-score'         // Use output from highest scoring agent
  | 'ensemble'           // Combine all outputs intelligently
  | 'consensus-threshold'// Require N% agreement
  | 'first-response'     // Use first response received
  | 'longest'            // Use longest response
  | 'custom';            // User-provided aggregation function

/**
 * Configuration for multi-agent consensus
 */
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
  nodeState?: NodeState;
}

export interface SemanticSimilarityConfig {
  enabled: boolean;
  method?: 'text-overlap' | 'openai-embedding' | 'peer-embedding' | 'custom';
  threshold?: number;
  openaiApiKey?: string;
  embeddingModel?: string;
  requireExchange?: boolean;
  customSimilarityFn?: (text1: string, text2: string) => Promise<number>;
}

/**
 * Load balancing configuration
 */
export interface LoadBalancingConfig {
  enabled: boolean;

  // Track request counts per agent
  trackRequestCounts?: boolean;

  // Prefer agents with fewer recent requests
  preferLessLoaded?: boolean;

  // Maximum concurrent requests per agent
  maxConcurrentPerAgent?: number;

  // Weight for load factor in selection (0-1)
  loadWeight?: number;
}

/**
 * Response from a single agent
 */
export interface AgentResponse {
  peer: PeerInfo;
  matchScore: number;
  response: any;
  timestamp: number;
  latency: number;
  error?: Error;
  success: boolean;
}

/**
 * Aggregated result from multiple agents
 */
export interface AggregatedResult {
  // Final aggregated output
  result: any;

  // All individual responses
  responses: AgentResponse[];

  // Consensus information
  consensus: {
    achieved: boolean;
    confidence: number; // 0-1
    agreement: number;  // Number of agents that agreed
    strategy: AggregationStrategy;
  };

  // Performance metrics
  metrics: {
    totalAgents: number;
    successfulAgents: number;
    failedAgents: number;
    averageLatency: number;
    totalTime: number;
  };

  // Agent rankings
  rankings?: {
    peer: PeerInfo;
    score: number;
    contribution: number; // How much this agent influenced final result
  }[];
}

/**
 * Vote for a particular output
 */
export interface Vote {
  value: any;
  weight: number;
  voter: PeerInfo;
}

/**
 * Request state for tracking multi-agent requests
 */
export interface MultiAgentRequestState {
  requestId: string;
  startTime: number;
  targetAgents: CapabilityMatch[];
  responses: AgentResponse[];
  completed: boolean;
  config: MultiAgentConfig;
}

/**
 * Load balancing state for tracking agent usage
 */
export interface AgentLoadState {
  peerId: string;
  activeRequests: number;
  totalRequests: number;
  totalErrors: number;
  averageLatency: number;
  lastRequestTime: number;
  successRate: number;
}
