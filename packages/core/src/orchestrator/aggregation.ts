import type { AgentResponse, AggregatedResult, MultiAgentConfig } from './types';
import { findConsensus } from './semantic-similarity';
import { getMetrics, calculatePerformanceScore } from '../node/peer-performance';
import { safeStringify } from '../utils/validation';

export type AggregationResult = {
  result: unknown;
  confidence: number;
  agreement: number;
};

export type AggregationStrategyFn = (
  responses: AgentResponse[],
  config?: MultiAgentConfig
) => Promise<AggregationResult>;

const rankAgents = (
  responses: AgentResponse[]
): { peer: AgentResponse['peer']; score: number; contribution: number }[] => {
  const contributions = responses.map((r) => ({
    peer: r.peer,
    score: r.matchScore,
    rawContribution: r.matchScore * (1 / (r.latency + 1)),
  }));
  const maxContribution = Math.max(...contributions.map(c => c.rawContribution), 1);
  return contributions.map(c => ({
    peer: c.peer,
    score: c.score,
    contribution: Math.min(1.0, c.rawContribution / maxContribution),
  }));
};

export const majorityVote: AggregationStrategyFn = async (responses, config) => {
  if (config?.semanticSimilarity?.enabled) {
    const threshold = config.semanticSimilarity.threshold;
    if (threshold !== undefined && (threshold < 0 || threshold > 1)) {
      throw new Error(`Invalid semantic similarity threshold: ${threshold}. Must be between 0 and 1.`);
    }
    const values = responses.map((r) => r.response);
    const consensusResult = await findConsensus(values, {
      method: config.semanticSimilarity.method,
      threshold: threshold,
      openaiApiKey: config.semanticSimilarity.openaiApiKey,
      embeddingModel: config.semanticSimilarity.embeddingModel,
      requireExchange: config.semanticSimilarity.requireExchange,
      nodeRef: config.nodeRef,
      localEmbedFn: config.semanticSimilarity.localEmbedFn,
    });

    if (consensusResult.consensusIndices.length === 0) {
      throw new Error('Consensus returned no indices');
    }

    return {
      result: values[consensusResult.consensusIndices[0]],
      confidence: consensusResult.confidence,
      agreement: consensusResult.consensusIndices.length,
    };
  }

  const votes = new Map<string, { value: unknown; count: number }>();

  for (const response of responses) {
    const key = safeStringify(response.response);
    const existing = votes.get(key);
    if (existing) {
      existing.count++;
    } else {
      votes.set(key, { value: response.response, count: 1 });
    }
  }

  let maxCount = 0;
  let result: unknown = null;

  for (const vote of votes.values()) {
    if (vote.count > maxCount) {
      maxCount = vote.count;
      result = vote.value;
    }
  }

  return {
    result,
    confidence: responses.length > 0 ? maxCount / responses.length : 0,
    agreement: maxCount,
  };
};

export const weightedVote: AggregationStrategyFn = async (responses, config) => {
  if (config?.semanticSimilarity?.enabled) {
    return majorityVote(responses, config);
  }

  const votes = new Map<string, { value: unknown; weight: number; count: number }>();

  for (const response of responses) {
    const key = safeStringify(response.response);

    let performanceScore = 0.5;
    if (config?.nodeRef?.current.performanceTracker) {
      try {
        const metrics = await getMetrics(config.nodeRef.current.performanceTracker, response.peer.id);
        performanceScore = metrics ? calculatePerformanceScore(metrics) : 0.5;
      } catch {
        performanceScore = 0.5;
      }
    }

    const weight = response.matchScore * (performanceScore + 0.5);

    const existing = votes.get(key);
    if (existing) {
      existing.weight += weight;
      existing.count++;
    } else {
      votes.set(key, { value: response.response, weight, count: 1 });
    }
  }

  let maxWeight = 0;
  let result: unknown = null;
  let agreementCount = 0;

  for (const vote of votes.values()) {
    if (vote.weight > maxWeight) {
      maxWeight = vote.weight;
      result = vote.value;
      agreementCount = vote.count;
    }
  }

  const totalWeight = Array.from(votes.values()).reduce((sum, v) => sum + v.weight, 0);

  return {
    result,
    confidence: totalWeight > 0 ? maxWeight / totalWeight : 0,
    agreement: agreementCount,
  };
};

export const bestScore: AggregationStrategyFn = async (responses) => {
  if (responses.length === 0) {
    throw new Error('Cannot find best score from empty responses');
  }

  const best = responses.reduce((prev, current) =>
    current.matchScore > prev.matchScore ? current : prev
  );

  return { result: best.response, confidence: 1.0, agreement: 1 };
};

export const ensemble: AggregationStrategyFn = async (responses) => {
  const textResponses = responses.map((r) => {
    if (typeof r.response === 'string') return r.response;
    if (typeof r.response === 'object' && r.response !== null && 'text' in r.response) {
      return (r.response as { text: string }).text;
    }
    return JSON.stringify(r.response);
  });

  return {
    result: {
      ensemble: true,
      responses: responses.map((r, i) => ({
        agentId: r.peer.id,
        score: r.matchScore,
        output: textResponses[i],
      })),
      summary: `Combined output from ${responses.length} agents`,
    },
    confidence: 1.0,
    agreement: responses.length,
  };
};

export const consensusThreshold = async (
  responses: AgentResponse[],
  threshold: number,
  config?: MultiAgentConfig
): Promise<AggregationResult> => {
  const { result, confidence, agreement } = await majorityVote(responses, config);

  if (confidence < threshold) {
    throw new Error(`Consensus threshold not met: ${confidence.toFixed(2)} < ${threshold}`);
  }

  return { result, confidence, agreement };
};

export const firstResponse: AggregationStrategyFn = async (responses) => {
  if (responses.length === 0) {
    throw new Error('Cannot find first response from empty responses');
  }

  const fastest = responses.reduce((prev, current) =>
    current.timestamp < prev.timestamp ? current : prev
  );

  return { result: fastest.response, confidence: 1.0, agreement: 1 };
};

export const longest: AggregationStrategyFn = async (responses) => {
  if (responses.length === 0) {
    throw new Error('Cannot find longest response from empty responses');
  }

  const getLengthValue = (r: AgentResponse): number => {
    if (typeof r.response === 'string') return r.response.length;
    if (typeof r.response === 'object' && r.response !== null && 'text' in r.response) {
      return ((r.response as { text: string }).text || '').length;
    }
    return JSON.stringify(r.response).length;
  };

  const longestResponse = responses.reduce((prev, current) =>
    getLengthValue(current) > getLengthValue(prev) ? current : prev
  );

  return { result: longestResponse.response, confidence: 1.0, agreement: 1 };
};

export const synthesizedConsensus = async (
  responses: AgentResponse[],
  config: MultiAgentConfig
): Promise<AggregationResult> => {
  if (!config.synthesizeFn) {
    throw new Error('synthesizeFn is required for synthesized-consensus strategy');
  }

  if (!config.originalQuery) {
    throw new Error('originalQuery is required for synthesized-consensus strategy');
  }

  const synthesizedText = await config.synthesizeFn(config.originalQuery, responses);

  return {
    result: { text: synthesizedText, synthesized: true, sourceCount: responses.length },
    confidence: 1.0,
    agreement: responses.length,
  };
};

export const aggregateResponses = async (
  responses: AgentResponse[],
  config: MultiAgentConfig
): Promise<AggregatedResult> => {
  const successful = responses.filter((r) => r.success);
  const failed = responses.filter((r) => !r.success);

  if (successful.length === 0) {
    throw new Error('All agent requests failed');
  }

  const strategy = config.aggregationStrategy;
  let aggregationResult: AggregationResult;

  switch (strategy) {
    case 'majority-vote':
      aggregationResult = await majorityVote(successful, config);
      break;

    case 'weighted-vote':
      aggregationResult = await weightedVote(successful, config);
      break;

    case 'best-score':
      aggregationResult = await bestScore(successful, config);
      break;

    case 'ensemble':
      aggregationResult = await ensemble(successful, config);
      break;

    case 'consensus-threshold':
      aggregationResult = await consensusThreshold(
        successful,
        config.consensusThreshold || 0.6,
        config
      );
      break;

    case 'first-response':
      aggregationResult = await firstResponse(successful, config);
      break;

    case 'longest':
      aggregationResult = await longest(successful, config);
      break;

    case 'synthesized-consensus':
      aggregationResult = await synthesizedConsensus(successful, config);
      break;

    case 'custom':
      if (!config.customAggregator) {
        throw new Error('Custom aggregator function not provided');
      }
      return config.customAggregator(successful);

    default:
      aggregationResult = {
        result: successful[0].response,
        confidence: 1.0,
        agreement: 1,
      };
  }

  const totalLatency = successful.reduce((sum, r) => sum + r.latency, 0);

  return {
    result: aggregationResult.result,
    responses,
    consensus: {
      achieved: aggregationResult.agreement >= (config.minAgents || 1),
      confidence: aggregationResult.confidence,
      agreement: aggregationResult.agreement,
      strategy,
    },
    metrics: {
      totalAgents: responses.length,
      successfulAgents: successful.length,
      failedAgents: failed.length,
      averageLatency: totalLatency / successful.length,
      totalTime: 0,
    },
    rankings: rankAgents(successful),
  };
};
