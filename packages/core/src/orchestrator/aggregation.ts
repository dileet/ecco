import { Effect } from 'effect';
import type { AgentResponse, AggregatedResult, MultiAgentConfig } from './types';
import { findConsensus } from './semantic-similarity';
import { getMetrics, calculatePerformanceScore } from '../node/peer-performance';

type AggregationResult = {
  result: unknown;
  confidence: number;
  agreement: number;
};

type AggregationStrategyFn = (responses: AgentResponse[], config?: MultiAgentConfig) => Effect.Effect<AggregationResult, Error>;

function unwrapResponse(response: AgentResponse): unknown {
  let responseValue = response.response;
  if (typeof responseValue === 'object' && responseValue !== null && 'type' in responseValue && responseValue.type === 'message' && 'payload' in responseValue) {
    responseValue = responseValue.payload;
  }
  return responseValue;
}

export namespace AggregationStrategy {
  export const majorityVote: AggregationStrategyFn = (responses, config) =>
    Effect.gen(function* () {
      if (config?.semanticSimilarity?.enabled) {
        const unwrapped = responses.map(unwrapResponse);
        const consensusResult = yield* findConsensus(unwrapped, {
          method: config.semanticSimilarity.method,
          threshold: config.semanticSimilarity.threshold,
          openaiApiKey: config.semanticSimilarity.openaiApiKey,
          embeddingModel: config.semanticSimilarity.embeddingModel,
          requireExchange: config.semanticSimilarity.requireExchange,
          nodeState: config.nodeState,
        });

        return {
          result: unwrapped[consensusResult.consensusIndices[0]],
          confidence: consensusResult.confidence,
          agreement: consensusResult.consensusIndices.length,
        };
      }

      const votes = new Map<string, { value: unknown; count: number }>();

      for (const response of responses) {
        const responseValue = unwrapResponse(response);
        const key = JSON.stringify(responseValue);
        const existing = votes.get(key);
        if (existing) {
          existing.count++;
        } else {
          votes.set(key, { value: responseValue, count: 1 });
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
        confidence: maxCount / responses.length,
        agreement: maxCount,
      };
    });

  export const weightedVote: AggregationStrategyFn = (responses, config) =>
    Effect.gen(function* () {
      if (config?.semanticSimilarity?.enabled) {
        return yield* majorityVote(responses, config);
      }

      const votes = new Map<string, { value: unknown; weight: number; count: number }>();

      for (const response of responses) {
        const responseValue = unwrapResponse(response);
        const key = JSON.stringify(responseValue);

        let performanceScore = 0.5;
        if (config?.nodeState?.performanceTracker) {
          const metrics = yield* getMetrics(config.nodeState.performanceTracker, response.peer.id);
          performanceScore = metrics ? calculatePerformanceScore(metrics) : 0.5;
        }

        const weight = response.matchScore * (performanceScore + 0.5);

        const existing = votes.get(key);
        if (existing) {
          existing.weight += weight;
          existing.count++;
        } else {
          votes.set(key, { value: responseValue, weight, count: 1 });
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
        confidence: maxWeight / totalWeight,
        agreement: agreementCount,
      };
    });

  export const bestScore: AggregationStrategyFn = (responses) => {
    const best = responses.reduce((prev, current) =>
      current.matchScore > prev.matchScore ? current : prev
    );

    const responseValue = unwrapResponse(best);

    return Effect.succeed({ result: responseValue, confidence: 1.0, agreement: 1 });
  };

  export const ensemble: AggregationStrategyFn = (responses) => {
    const textResponses = responses.map((r) => {
      const responseValue = unwrapResponse(r);

      if (typeof responseValue === 'string') return responseValue;
      if (typeof responseValue === 'object' && responseValue !== null && 'text' in responseValue) {
        return (responseValue as { text: string }).text;
      }
      return JSON.stringify(responseValue);
    });

    return Effect.succeed({
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
    });
  };

  export const consensusThreshold = (threshold: number, config?: MultiAgentConfig): AggregationStrategyFn =>
    (responses) =>
      Effect.gen(function* () {
        const { result, confidence, agreement } = yield* majorityVote(responses, config);

        if (confidence < threshold) {
          return yield* Effect.fail(
            new Error(`Consensus threshold not met: ${confidence.toFixed(2)} < ${threshold}`)
          );
        }

        return { result, confidence, agreement };
      });

  export const firstResponse: AggregationStrategyFn = (responses) => {
    const fastest = responses.reduce((prev, current) =>
      current.timestamp < prev.timestamp ? current : prev
    );

    const responseValue = unwrapResponse(fastest);

    return Effect.succeed({ result: responseValue, confidence: 1.0, agreement: 1 });
  };

  export const longest: AggregationStrategyFn = (responses) => {
    const getLengthValue = (r: AgentResponse): number => {
      const responseValue = unwrapResponse(r);

      if (typeof responseValue === 'string') return responseValue.length;
      if (typeof responseValue === 'object' && responseValue !== null && 'text' in responseValue) {
        return ((responseValue as { text: string }).text || '').length;
      }
      return JSON.stringify(responseValue).length;
    };

    const longest = responses.reduce((prev, current) =>
      getLengthValue(current) > getLengthValue(prev) ? current : prev
    );

    const responseValue = unwrapResponse(longest);

    return Effect.succeed({ result: responseValue, confidence: 1.0, agreement: 1 });
  };
}

function rankAgents(responses: AgentResponse[]): { peer: AgentResponse['peer']; score: number; contribution: number }[] {
  return responses.map((r) => ({
    peer: r.peer,
    score: r.matchScore,
    contribution: r.matchScore * (1 / (r.latency + 1)),
  }));
}

export const aggregateResponses = (
  responses: AgentResponse[],
  config: MultiAgentConfig
): Effect.Effect<AggregatedResult, Error> =>
  Effect.gen(function* () {
    const successful = responses.filter((r) => r.success);
    const failed = responses.filter((r) => !r.success);

    if (successful.length === 0) {
      return yield* Effect.fail(new Error('All agent requests failed'));
    }

    const strategy = config.aggregationStrategy;
    let strategyEffect: Effect.Effect<AggregationResult, Error>;

    switch (strategy) {
      case 'majority-vote':
        strategyEffect = AggregationStrategy.majorityVote(successful, config);
        break;

      case 'weighted-vote':
        strategyEffect = AggregationStrategy.weightedVote(successful, config);
        break;

      case 'best-score':
        strategyEffect = AggregationStrategy.bestScore(successful, config);
        break;

      case 'ensemble':
        strategyEffect = AggregationStrategy.ensemble(successful, config);
        break;

      case 'consensus-threshold':
        strategyEffect = AggregationStrategy.consensusThreshold(
          config.consensusThreshold || 0.6,
          config
        )(successful);
        break;

      case 'first-response':
        strategyEffect = AggregationStrategy.firstResponse(successful, config);
        break;

      case 'longest':
        strategyEffect = AggregationStrategy.longest(successful, config);
        break;

      case 'custom':
        if (!config.customAggregator) {
          return yield* Effect.fail(new Error('Custom aggregator function not provided'));
        }
        return config.customAggregator(successful);

      default:
        strategyEffect = Effect.succeed({
          result: successful[0].response,
          confidence: 1.0,
          agreement: 1,
        });
    }

    const { result, confidence, agreement } = yield* strategyEffect;

    const totalLatency = successful.reduce((sum, r) => sum + r.latency, 0);

    return {
      result,
      responses,
      consensus: {
        achieved: agreement >= (config.minAgents || 1),
        confidence,
        agreement,
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
  });
