import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
  LanguageModelV2CallWarning,
  LanguageModelV2FinishReason,
  LanguageModelV2Content,
  LanguageModelV2Usage,
} from '@ai-sdk/provider';
import { findPeers, subscribeToTopic, sendMessage, getId, withTimeout, type StateRef, type NodeState, type CapabilityQuery } from '@ecco/core';
import { nanoid } from 'nanoid';
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

const ResponseSchema = z.object({
  text: z.string().optional(),
  finishReason: z.string().optional(),
  usage: UsageSchema.optional(),
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

interface EccoProviderConfig {
  nodeRef: StateRef<NodeState>;
  fallbackProvider?: LanguageModelV2;
  timeout?: number;
}

type EccoLanguageModel = LanguageModelV2 & {
  defaultObjectGenerationMode: 'json';
};

interface EccoLanguageModelState {
  readonly specificationVersion: 'v2';
  readonly provider: 'ecco';
  readonly modelId: string;
  readonly defaultObjectGenerationMode: 'json';
  readonly supportedUrls: Record<string, never>;
  readonly config: EccoProviderConfig;
}

interface GenerateResult {
  readonly content: LanguageModelV2Content[];
  readonly finishReason: LanguageModelV2FinishReason;
  readonly usage: LanguageModelV2Usage;
  readonly warnings: LanguageModelV2CallWarning[];
}

interface StreamResult {
  readonly stream: ReadableStream<LanguageModelV2StreamPart>;
}

const createState = (modelId: string, config: EccoProviderConfig): EccoLanguageModelState => ({
  specificationVersion: 'v2',
  provider: 'ecco',
  modelId,
  defaultObjectGenerationMode: 'json',
  supportedUrls: {},
  config,
});

const waitForResponse = async (
  nodeRef: StateRef<NodeState>,
  requestId: string,
  timeout: number
): Promise<unknown> => {
  let unsubscribe: (() => void) | undefined;

  const responsePromise = new Promise<unknown>((resolve) => {
    let resolved = false;

    unsubscribe = subscribeToTopic(nodeRef, `response:${requestId}`, (data: unknown) => {
      if (!resolved) {
        resolved = true;
        const message = MessagePayloadSchema.safeParse(data);
        resolve(message.success ? message.data.payload : data);
      }
    });
  });

  try {
    return await withTimeout(responsePromise, timeout, 'Request timeout');
  } finally {
    unsubscribe?.();
  }
};

const parseResponse = (response: unknown): GenerateResult => {
  const parsed = ResponseSchema.safeParse(response);

  if (!parsed.success) {
    return {
      content: [],
      finishReason: 'error',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      warnings: [],
    };
  }

  const { text, finishReason, usage, warnings } = parsed.data;
  const inputTokens = usage?.promptTokens ?? usage?.inputTokens ?? 0;
  const outputTokens = usage?.completionTokens ?? usage?.outputTokens ?? 0;

  return {
    content: text ? [{ type: 'text', text }] : [],
    finishReason: FinishReasonSchema.parse(finishReason),
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    warnings: warnings ?? [],
  };
};

const buildCapabilityQuery = (modelId: string): CapabilityQuery => ({
  requiredCapabilities: [{ type: 'agent', name: modelId }],
});

const doGenerate = async (
  state: EccoLanguageModelState,
  options: LanguageModelV2CallOptions
): Promise<GenerateResult> => {
  const matches = await findPeers(state.config.nodeRef, buildCapabilityQuery(state.modelId));

  if (matches.length === 0) {
    if (state.config.fallbackProvider) {
      return state.config.fallbackProvider.doGenerate(options);
    }
    throw new Error(`No peers found with capability: ${state.modelId}`);
  }

  const bestMatch = matches[0];
  const requestId = nanoid();

  await sendMessage(state.config.nodeRef, bestMatch.peer.id, {
    id: requestId,
    from: getId(state.config.nodeRef),
    to: bestMatch.peer.id,
    type: 'agent-request' as const,
    payload: { model: state.modelId, options },
    timestamp: Date.now(),
  });

  const response = await waitForResponse(
    state.config.nodeRef,
    requestId,
    state.config.timeout ?? 30000
  );

  return parseResponse(response);
};

const doStream = async (
  state: EccoLanguageModelState,
  options: LanguageModelV2CallOptions
): Promise<StreamResult> => {
  const matches = await findPeers(state.config.nodeRef, buildCapabilityQuery(state.modelId));

  if (matches.length === 0) {
    if (state.config.fallbackProvider) {
      return state.config.fallbackProvider.doStream(options);
    }
    throw new Error(`No peers found with capability: ${state.modelId}`);
  }

  const bestMatch = matches[0];
  const requestId = nanoid();

  await sendMessage(state.config.nodeRef, bestMatch.peer.id, {
    id: requestId,
    from: getId(state.config.nodeRef),
    to: bestMatch.peer.id,
    type: 'agent-request' as const,
    payload: { model: state.modelId, prompt: options.prompt, stream: true },
    timestamp: Date.now(),
  });

  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      unsubscribe = subscribeToTopic(state.config.nodeRef, `response:${requestId}`, (data: unknown) => {
        const chunk = StreamChunkSchema.safeParse(data);
        if (chunk.success) {
          controller.enqueue({ type: 'text-delta', id: nanoid(), delta: chunk.data.text });
          return;
        }

        const done = StreamDoneSchema.safeParse(data);
        if (done.success) {
          const inputTokens = done.data.usage?.inputTokens ?? 0;
          const outputTokens = done.data.usage?.outputTokens ?? 0;
          controller.enqueue({
            type: 'finish',
            finishReason: FinishReasonSchema.parse(done.data.finishReason),
            usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
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

const createEccoProvider = (config: EccoProviderConfig) => ({
  languageModel: (modelId: string): EccoLanguageModel => {
    const state = createState(modelId, config);

    return {
      specificationVersion: state.specificationVersion,
      provider: state.provider,
      modelId: state.modelId,
      defaultObjectGenerationMode: state.defaultObjectGenerationMode,
      supportedUrls: state.supportedUrls,

      async doGenerate(options) {
        return doGenerate(state, options);
      },

      async doStream(options) {
        return doStream(state, options);
      },
    };
  },
});

export {
  createState,
  parseResponse,
  doGenerate,
  doStream,
  createEccoProvider,
};

export type {
  EccoProviderConfig,
  EccoLanguageModelState,
  EccoLanguageModel,
  GenerateResult as EccoGenerateResult,
  StreamResult as EccoStreamResult,
};
