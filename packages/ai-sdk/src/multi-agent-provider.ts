/**
 * Enhanced AI SDK provider with multi-agent consensus support
 */

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
  LanguageModelV2CallWarning,
  LanguageModelV2FinishReason,
  LanguageModelV2Content,
  LanguageModelV2Usage,
} from '@ai-sdk/provider';
import {
  Node,
  Orchestrator,
  type NodeState,
  type OrchestratorState,
  type CapabilityQuery,
  type MultiAgentConfig,
  type AggregatedResult,
} from '@ecco/core';

interface MultiAgentProviderConfig {
  nodeState: NodeState;
  orchestratorState: OrchestratorState;
  multiAgentConfig: MultiAgentConfig;
  fallbackProvider?: LanguageModelV2;
  enableMetadata?: boolean;
}

export class MultiAgentLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'ecco-multi-agent';
  readonly modelId: string;
  readonly defaultObjectGenerationMode = 'json' as const;
  readonly supportedUrls = {} as const;

  private config: MultiAgentProviderConfig;
  private orchestratorState: OrchestratorState;

  constructor(modelId: string, config: MultiAgentProviderConfig) {
    this.modelId = modelId;
    this.config = config;
    this.orchestratorState = config.orchestratorState;
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<{
    content: LanguageModelV2Content[];
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    warnings: LanguageModelV2CallWarning[];
    metadata?: any;
  }> {
    // Build capability query
    const query: CapabilityQuery = {
      requiredCapabilities: [
        {
          type: 'agent',
          name: this.modelId,
        },
      ],
    };

    try {
      const { result: aggregated, state: newState, nodeState: newNodeState } = await Orchestrator.execute(
        this.config.nodeState,
        this.orchestratorState,
        query,
        {
          model: this.modelId,
          options: options,
        },
        this.config.multiAgentConfig
      );
      this.orchestratorState = newState;
      this.config.nodeState = newNodeState;

      // Extract result based on aggregation strategy
      const result = this.extractResult(aggregated);

      // Build usage stats (aggregate from all agents)
      const usage = this.aggregateUsage(aggregated);

      const response: {
        content: LanguageModelV2Content[];
        finishReason: LanguageModelV2FinishReason;
        usage: LanguageModelV2Usage;
        warnings: LanguageModelV2CallWarning[];
        metadata?: any;
      } = {
        content: result.text ? [{ type: 'text', text: result.text }] : [],
        finishReason: result.finishReason || 'stop',
        usage,
        warnings: result.warnings || [],
      };

      // Add consensus metadata if enabled
      if (this.config.enableMetadata) {
        response.metadata = {
          consensus: aggregated.consensus,
          metrics: aggregated.metrics,
          rankings: aggregated.rankings,
          strategy: this.config.multiAgentConfig.aggregationStrategy,
          agentResponses: aggregated.responses.map((r) => ({
            agentId: r.peer.id,
            success: r.success,
            latency: r.latency,
            score: r.matchScore,
          })),
        };
      }

      return response;
    } catch (error) {
      // Fallback to single provider if available
      if (this.config.fallbackProvider) {
        console.log('Multi-agent consensus failed, falling back to local provider');
        return this.config.fallbackProvider.doGenerate(options);
      }
      throw error;
    }
  }

  async doStream(options: LanguageModelV2CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>;
  }> {
    // For streaming, we'll use a modified approach
    // Option 1: Stream from fastest agent (first-response strategy)
    // Option 2: Collect all streams and merge them
    // For simplicity, we'll use first-response here

    const query: CapabilityQuery = {
      requiredCapabilities: [
        {
          type: 'agent',
          name: this.modelId,
        },
      ],
    };

    // Use first-response strategy for streaming
    const streamConfig: MultiAgentConfig = {
      ...this.config.multiAgentConfig,
      aggregationStrategy: 'first-response',
      agentCount: 1, // Only stream from one agent
    };

    const { matches, state: updatedNodeState } = await Node.findPeers(this.config.nodeState, query);
    this.config.nodeState = updatedNodeState;

    if (matches.length === 0) {
      if (this.config.fallbackProvider) {
        console.log('No peers found, falling back to local provider');
        return this.config.fallbackProvider.doStream(options);
      }
      throw new Error(`No peers found with capability: ${this.modelId}`);
    }

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start: async (controller) => {
        const requestId = `stream-${Date.now()}`;
        const bestMatch = matches[0];

        this.config.nodeState = Node.subscribeToTopic(this.config.nodeState, `response:${requestId}`, (data: unknown) => {
          if (typeof data === 'object' && data !== null && 'type' in data) {
            if (data.type === 'chunk' && 'text' in data) {
              controller.enqueue({
                type: 'text-delta',
                id: requestId,
                delta: typeof data.text === 'string' ? data.text : '',
              });
            } else if (data.type === 'done') {
              const finishReason = 'finishReason' in data && typeof data.finishReason === 'string'
                ? data.finishReason
                : 'stop';
              const usage = 'usage' in data ? data.usage : undefined;

              controller.enqueue({
                type: 'finish',
                finishReason: finishReason as LanguageModelV2FinishReason,
                usage: usage as LanguageModelV2Usage,
              });
              controller.close();
            }
          }
        });

        this.config.nodeState = await Node.sendMessage(this.config.nodeState, bestMatch.peer.id, {
          id: requestId,
          from: Node.getId(this.config.nodeState),
          to: bestMatch.peer.id,
          type: 'agent-request' as const,
          payload: {
            model: this.modelId,
            options: options,
            stream: true,
          },
          timestamp: Date.now(),
        });
      },
    });

    return { stream };
  }

  private extractResult(aggregated: AggregatedResult): { text?: string; finishReason: LanguageModelV2FinishReason; warnings: LanguageModelV2CallWarning[] } {
    let result = aggregated.result;

    // Unwrap MessageEvent if present
    if (typeof result === 'object' && result !== null && 'type' in result && result.type === 'message' && 'payload' in result) {
      result = result.payload;
    }

    if (typeof result === 'string') {
      return { text: result, finishReason: 'stop', warnings: [] };
    }

    if (typeof result === 'object' && result !== null && 'ensemble' in result && result.ensemble && 'responses' in result && Array.isArray(result.responses)) {
      const combinedText = result.responses
        .map((r: { agentId: string; output: string }) => `[Agent ${r.agentId}]: ${r.output}`)
        .join('\n\n');

      return {
        text: combinedText,
        finishReason: 'stop',
        warnings: [],
      };
    }

    if (typeof result === 'object' && result !== null && 'text' in result) {
      const finishReason: LanguageModelV2FinishReason =
        ('finishReason' in result && typeof result.finishReason === 'string' &&
         ['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', 'unknown'].includes(result.finishReason))
          ? result.finishReason
          : 'stop';

      const warnings: LanguageModelV2CallWarning[] =
        ('warnings' in result && Array.isArray(result.warnings)) ? result.warnings : [];

      return {
        text: typeof result.text === 'string' ? result.text : undefined,
        finishReason,
        warnings,
      };
    }

    return { finishReason: 'stop', warnings: [] };
  }

  /**
   * Aggregate usage statistics from all agents
   */
  private aggregateUsage(aggregated: AggregatedResult): LanguageModelV2Usage {
    const successful = aggregated.responses.filter((r) => r.success);

    // Sum up usage from all successful responses
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const response of successful) {
      const usage = response.response?.usage;
      if (usage) {
        totalInputTokens += usage.promptTokens || usage.inputTokens || 0;
        totalOutputTokens += usage.completionTokens || usage.outputTokens || 0;
      }
    }

    // Average the usage (since we're aggregating results, not summing costs)
    const avgInputTokens = Math.ceil(totalInputTokens / successful.length);
    const avgOutputTokens = Math.ceil(totalOutputTokens / successful.length);

    return {
      inputTokens: avgInputTokens,
      outputTokens: avgOutputTokens,
      totalTokens: avgInputTokens + avgOutputTokens,
    };
  }

  getLoadStatistics() {
    return Orchestrator.getLoadStatistics(this.orchestratorState);
  }

  resetLoadStatistics() {
    this.orchestratorState = Orchestrator.resetLoadStatistics(this.orchestratorState);
  }
}

export function createMultiAgentProvider(config: MultiAgentProviderConfig) {
  return {
    languageModel: (modelId: string) =>
      new MultiAgentLanguageModel(modelId, config),
  };
}
