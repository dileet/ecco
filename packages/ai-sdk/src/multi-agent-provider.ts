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
  findPeers,
  subscribeToTopic,
  sendMessage,
  getId,
  executeOrchestration,
  getLoadStatistics as getOrchestratorLoadStatistics,
  resetLoadStatistics as resetOrchestratorLoadStatistics,
  type StateRef,
  type NodeState,
  type OrchestratorState,
  type CapabilityQuery,
  type MultiAgentConfig,
  type AggregatedResult,
} from '@ecco/core';
import { z } from 'zod';

const FinishReasonSchema = z
  .enum(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', 'unknown'])
  .catch('stop');

const UsageSchema = z.object({
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});


const MessagePayloadSchema = z.object({
  type: z.literal('message'),
  payload: z.unknown(),
});

const EnsembleResultSchema = z.object({
  ensemble: z.literal(true),
  responses: z.array(z.object({
    agentId: z.string(),
    output: z.string(),
  })),
});

const TextResultSchema = z.object({
  text: z.string().optional(),
  finishReason: z.string().optional(),
  warnings: z.array(z.custom<LanguageModelV2CallWarning>()).optional(),
});

const StreamChunkSchema = z.object({
  type: z.literal('chunk'),
  text: z.string(),
});

const StreamDoneSchema = z.object({
  type: z.literal('done'),
  finishReason: z.string().optional(),
  usage: UsageSchema.optional(),
});

interface MultiAgentProviderConfig {
  nodeRef: StateRef<NodeState>;
  orchestratorState: OrchestratorState;
  multiAgentConfig: MultiAgentConfig;
  fallbackProvider?: LanguageModelV2;
  enableMetadata?: boolean;
}

type MultiAgentLanguageModel = LanguageModelV2 & {
  defaultObjectGenerationMode: 'json';
  getLoadStatistics: () => Record<string, unknown>;
  resetLoadStatistics: () => void;
};

interface MultiAgentLanguageModelState {
  readonly specificationVersion: 'v2';
  readonly provider: 'ecco-multi-agent';
  readonly modelId: string;
  readonly defaultObjectGenerationMode: 'json';
  readonly supportedUrls: Record<string, never>;
  readonly config: MultiAgentProviderConfig;
  orchestratorState: OrchestratorState;
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
  const messagePayload = MessagePayloadSchema.safeParse(aggregated.result);
  const result = messagePayload.success ? messagePayload.data.payload : aggregated.result;

  if (typeof result === 'string') {
    return { text: result, finishReason: 'stop', warnings: [] };
  }

  const ensemble = EnsembleResultSchema.safeParse(result);
  if (ensemble.success) {
    const combinedText = ensemble.data.responses
      .map((r) => `[Agent ${r.agentId}]: ${r.output}`)
      .join('\n\n');
    return { text: combinedText, finishReason: 'stop', warnings: [] };
  }

  const textResult = TextResultSchema.safeParse(result);
  if (textResult.success) {
    return {
      text: textResult.data.text,
      finishReason: FinishReasonSchema.parse(textResult.data.finishReason),
      warnings: textResult.data.warnings ?? [],
    };
  }

  return { finishReason: 'stop', warnings: [] };
};

const aggregateUsage = (aggregated: AggregatedResult): LanguageModelV2Usage => {
  const successful = aggregated.responses.filter((r) => r.success);
  if (successful.length === 0) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  let totalInput = 0;
  let totalOutput = 0;

  for (const item of successful) {
    const parsed = UsageSchema.safeParse(Object(item.response).usage);
    if (parsed.success) {
      totalInput += parsed.data.promptTokens ?? parsed.data.inputTokens ?? 0;
      totalOutput += parsed.data.completionTokens ?? parsed.data.outputTokens ?? 0;
    }
  }

  const avgInput = Math.ceil(totalInput / successful.length);
  const avgOutput = Math.ceil(totalOutput / successful.length);

  return { inputTokens: avgInput, outputTokens: avgOutput, totalTokens: avgInput + avgOutput };
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

const buildCapabilityQuery = (modelId: string): CapabilityQuery => ({
  requiredCapabilities: [{ type: 'agent', name: modelId }],
});

const doGenerate = async (
  state: MultiAgentLanguageModelState,
  options: LanguageModelV2CallOptions
): Promise<{ result: GenerateResult; orchestratorState: OrchestratorState }> => {
  try {
    const { result: aggregated, state: newOrchestratorState } = await executeOrchestration(
      state.config.nodeRef,
      state.orchestratorState,
      buildCapabilityQuery(state.modelId),
      { model: state.modelId, options },
      state.config.multiAgentConfig
    );

    const extracted = extractResult(aggregated);

    return {
      result: {
        content: extracted.text ? [{ type: 'text', text: extracted.text }] : [],
        finishReason: extracted.finishReason,
        usage: aggregateUsage(aggregated),
        warnings: extracted.warnings,
        ...(state.config.enableMetadata && {
          metadata: buildMetadata(aggregated, state.config.multiAgentConfig),
        }),
      },
      orchestratorState: newOrchestratorState,
    };
  } catch (error) {
    if (state.config.fallbackProvider) {
      return {
        result: await state.config.fallbackProvider.doGenerate(options),
        orchestratorState: state.orchestratorState,
      };
    }
    throw error;
  }
};

const doStream = async (
  state: MultiAgentLanguageModelState,
  options: LanguageModelV2CallOptions
): Promise<StreamResult> => {
  const matches = await findPeers(state.config.nodeRef, buildCapabilityQuery(state.modelId));

  if (matches.length === 0) {
    if (state.config.fallbackProvider) {
      return state.config.fallbackProvider.doStream(options);
    }
    throw new Error(`No peers found with capability: ${state.modelId}`);
  }

  const requestId = `stream-${Date.now()}`;
  const bestMatch = matches[0];

  await sendMessage(state.config.nodeRef, bestMatch.peer.id, {
    id: requestId,
    from: getId(state.config.nodeRef),
    to: bestMatch.peer.id,
    type: 'agent-request' as const,
    payload: { model: state.modelId, options, stream: true },
    timestamp: Date.now(),
  });

  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      unsubscribe = subscribeToTopic(state.config.nodeRef, `response:${requestId}`, (data: unknown) => {
        const chunk = StreamChunkSchema.safeParse(data);
        if (chunk.success) {
          controller.enqueue({ type: 'text-delta', id: requestId, delta: chunk.data.text });
          return;
        }

        const done = StreamDoneSchema.safeParse(data);
        if (done.success) {
          const input = done.data.usage?.inputTokens ?? 0;
          const output = done.data.usage?.outputTokens ?? 0;
          controller.enqueue({
            type: 'finish',
            finishReason: FinishReasonSchema.parse(done.data.finishReason),
            usage: { inputTokens: input, outputTokens: output, totalTokens: input + output },
          });
          unsubscribe?.();
          controller.close();
        }
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return { stream };
};

const getLoadStatistics = (state: MultiAgentLanguageModelState): Record<string, unknown> =>
  getOrchestratorLoadStatistics(state.orchestratorState);

const resetLoadStatistics = (state: MultiAgentLanguageModelState): MultiAgentLanguageModelState => ({
  ...state,
  orchestratorState: resetOrchestratorLoadStatistics(state.orchestratorState),
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
        const { result, orchestratorState } = await doGenerate(state, options);
        state = { ...state, orchestratorState };
        return result;
      },

      async doStream(options) {
        return doStream(state, options);
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
