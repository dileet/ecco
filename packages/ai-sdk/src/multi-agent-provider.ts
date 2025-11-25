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

type MultiAgentLanguageModel = LanguageModelV2 & {
  defaultObjectGenerationMode: 'json';
  getLoadStatistics: () => Map<string, unknown>;
  resetLoadStatistics: () => void;
};

interface MultiAgentLanguageModelState {
  readonly specificationVersion: 'v2';
  readonly provider: 'ecco-multi-agent';
  readonly modelId: string;
  readonly defaultObjectGenerationMode: 'json';
  readonly supportedUrls: Record<string, never>;
  readonly config: MultiAgentProviderConfig;
  readonly orchestratorState: OrchestratorState;
}

interface GenerateResult {
  readonly content: LanguageModelV2Content[];
  readonly finishReason: LanguageModelV2FinishReason;
  readonly usage: LanguageModelV2Usage;
  readonly warnings: LanguageModelV2CallWarning[];
  readonly metadata?: Record<string, unknown>;
}

interface StreamResult {
  readonly stream: ReadableStream<LanguageModelV2StreamPart>;
}

const VALID_FINISH_REASONS = [
  'stop',
  'length',
  'content-filter',
  'tool-calls',
  'error',
  'other',
  'unknown',
] as const;

const isValidFinishReason = (value: string): value is LanguageModelV2FinishReason =>
  VALID_FINISH_REASONS.includes(value as LanguageModelV2FinishReason);

const parseFinishReason = (value: unknown): LanguageModelV2FinishReason =>
  typeof value === 'string' && isValidFinishReason(value) ? value : 'stop';

const createState = (modelId: string, config: MultiAgentProviderConfig): MultiAgentLanguageModelState => ({
  specificationVersion: 'v2',
  provider: 'ecco-multi-agent',
  modelId,
  defaultObjectGenerationMode: 'json',
  supportedUrls: {},
  config,
  orchestratorState: config.orchestratorState,
});

const extractResult = (aggregated: AggregatedResult): {
  text?: string;
  finishReason: LanguageModelV2FinishReason;
  warnings: LanguageModelV2CallWarning[];
} => {
  let result = aggregated.result;

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
    return { text: combinedText, finishReason: 'stop', warnings: [] };
  }

  if (typeof result === 'object' && result !== null && 'text' in result) {
    const finishReason = parseFinishReason('finishReason' in result ? result.finishReason : undefined);
    const warnings: LanguageModelV2CallWarning[] =
      'warnings' in result && Array.isArray(result.warnings) ? result.warnings : [];
    return {
      text: typeof result.text === 'string' ? result.text : undefined,
      finishReason,
      warnings,
    };
  }

  return { finishReason: 'stop', warnings: [] };
};

const aggregateUsage = (aggregated: AggregatedResult): LanguageModelV2Usage => {
  const successful = aggregated.responses.filter((r) => r.success);

  if (successful.length === 0) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const response of successful) {
    const usage = response.response?.usage;
    if (usage) {
      totalInputTokens += usage.promptTokens || usage.inputTokens || 0;
      totalOutputTokens += usage.completionTokens || usage.outputTokens || 0;
    }
  }

  const avgInputTokens = Math.ceil(totalInputTokens / successful.length);
  const avgOutputTokens = Math.ceil(totalOutputTokens / successful.length);

  return {
    inputTokens: avgInputTokens,
    outputTokens: avgOutputTokens,
    totalTokens: avgInputTokens + avgOutputTokens,
  };
};

const buildMetadata = (
  aggregated: AggregatedResult,
  config: MultiAgentConfig
): Record<string, unknown> => ({
  consensus: aggregated.consensus,
  metrics: aggregated.metrics,
  rankings: aggregated.rankings,
  strategy: config.aggregationStrategy,
  agentResponses: aggregated.responses.map((r) => ({
    agentId: r.peer.id,
    success: r.success,
    latency: r.latency,
    score: r.matchScore,
  })),
});

const doGenerate = async (
  state: MultiAgentLanguageModelState,
  options: LanguageModelV2CallOptions
): Promise<{ result: GenerateResult; state: MultiAgentLanguageModelState }> => {
  const query: CapabilityQuery = {
    requiredCapabilities: [{ type: 'agent', name: state.modelId }],
  };

  try {
    const { result: aggregated, state: newOrchestratorState, nodeState: newNodeState } = await Orchestrator.execute(
      state.config.nodeState,
      state.orchestratorState,
      query,
      { model: state.modelId, options },
      state.config.multiAgentConfig
    );

    const newState: MultiAgentLanguageModelState = {
      ...state,
      orchestratorState: newOrchestratorState,
      config: { ...state.config, nodeState: newNodeState },
    };

    const extracted = extractResult(aggregated);
    const usage = aggregateUsage(aggregated);

    const result: GenerateResult = {
      content: extracted.text ? [{ type: 'text', text: extracted.text }] : [],
      finishReason: extracted.finishReason,
      usage,
      warnings: extracted.warnings,
      ...(state.config.enableMetadata && {
        metadata: buildMetadata(aggregated, state.config.multiAgentConfig),
      }),
    };

    return { result, state: newState };
  } catch (error) {
    if (state.config.fallbackProvider) {
      const result = await state.config.fallbackProvider.doGenerate(options);
      return { result, state };
    }
    throw error;
  }
};

const doStream = async (
  state: MultiAgentLanguageModelState,
  options: LanguageModelV2CallOptions
): Promise<{ result: StreamResult; state: MultiAgentLanguageModelState }> => {
  const query: CapabilityQuery = {
    requiredCapabilities: [{ type: 'agent', name: state.modelId }],
  };

  const { matches, state: updatedNodeState } = await Node.findPeers(state.config.nodeState, query);

  const stateAfterFind: MultiAgentLanguageModelState = {
    ...state,
    config: { ...state.config, nodeState: updatedNodeState },
  };

  if (matches.length === 0) {
    if (stateAfterFind.config.fallbackProvider) {
      const result = await stateAfterFind.config.fallbackProvider.doStream(options);
      return { result, state: stateAfterFind };
    }
    throw new Error(`No peers found with capability: ${state.modelId}`);
  }

  const requestId = `stream-${Date.now()}`;
  const bestMatch = matches[0];

  const subscribedNodeState = Node.subscribeToTopic(
    stateAfterFind.config.nodeState,
    `response:${requestId}`,
    () => {}
  );

  const stateAfterSubscribe: MultiAgentLanguageModelState = {
    ...stateAfterFind,
    config: { ...stateAfterFind.config, nodeState: subscribedNodeState },
  };

  const nodeStateAfterSend = await Node.sendMessage(
    stateAfterSubscribe.config.nodeState,
    bestMatch.peer.id,
    {
      id: requestId,
      from: Node.getId(stateAfterSubscribe.config.nodeState),
      to: bestMatch.peer.id,
      type: 'agent-request' as const,
      payload: { model: state.modelId, options, stream: true },
      timestamp: Date.now(),
    }
  );

  const finalState: MultiAgentLanguageModelState = {
    ...stateAfterSubscribe,
    config: { ...stateAfterSubscribe.config, nodeState: nodeStateAfterSend },
  };

  const stream = new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      Node.subscribeToTopic(finalState.config.nodeState, `response:${requestId}`, (data: unknown) => {
        if (typeof data === 'object' && data !== null && 'type' in data) {
          if (data.type === 'chunk' && 'text' in data) {
            controller.enqueue({
              type: 'text-delta',
              id: requestId,
              delta: typeof data.text === 'string' ? data.text : '',
            });
          } else if (data.type === 'done') {
            const finishReason = parseFinishReason('finishReason' in data ? data.finishReason : undefined);
            let usage: LanguageModelV2Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

            if ('usage' in data && typeof data.usage === 'object' && data.usage !== null) {
              const usageObj = data.usage;
              const inputTokens = 'inputTokens' in usageObj && typeof usageObj.inputTokens === 'number' ? usageObj.inputTokens : 0;
              const outputTokens = 'outputTokens' in usageObj && typeof usageObj.outputTokens === 'number' ? usageObj.outputTokens : 0;
              usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
            }

            controller.enqueue({ type: 'finish', finishReason, usage });
            controller.close();
          }
        }
      });
    },
  });

  return { result: { stream }, state: finalState };
};

const getLoadStatistics = (state: MultiAgentLanguageModelState): Map<string, unknown> =>
  Orchestrator.getLoadStatistics(state.orchestratorState);

const resetLoadStatistics = (state: MultiAgentLanguageModelState): MultiAgentLanguageModelState => ({
  ...state,
  orchestratorState: Orchestrator.resetLoadStatistics(state.orchestratorState),
});

const createMultiAgentProvider = (config: MultiAgentProviderConfig) => ({
  languageModel: (modelId: string): MultiAgentLanguageModel => {
    let state = createState(modelId, config);

    return {
      specificationVersion: state.specificationVersion,
      provider: state.provider,
      modelId: state.modelId,
      defaultObjectGenerationMode: state.defaultObjectGenerationMode,
      supportedUrls: state.supportedUrls,

      async doGenerate(options) {
        const { result, state: newState } = await doGenerate(state, options);
        state = newState;
        return result;
      },

      async doStream(options) {
        const { result, state: newState } = await doStream(state, options);
        state = newState;
        return result;
      },

      getLoadStatistics: () => getLoadStatistics(state),

      resetLoadStatistics() {
        state = resetLoadStatistics(state);
      },
    };
  },
});

export {
  createState,
  extractResult,
  aggregateUsage,
  buildMetadata,
  doGenerate,
  doStream,
  getLoadStatistics,
  resetLoadStatistics,
  createMultiAgentProvider,
};

export type {
  MultiAgentProviderConfig,
  MultiAgentLanguageModelState,
  MultiAgentLanguageModel,
  GenerateResult as MultiAgentGenerateResult,
  StreamResult as MultiAgentStreamResult,
};
