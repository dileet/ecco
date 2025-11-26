import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
  LanguageModelV2CallWarning,
  LanguageModelV2FinishReason,
  LanguageModelV2Content,
  LanguageModelV2Usage,
} from '@ai-sdk/provider';
import { findPeers, subscribeToTopic, sendMessage, getId, type StateRef, type NodeState, type CapabilityQuery } from '@ecco/core';
import { nanoid } from 'nanoid';

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

const createState = (modelId: string, config: EccoProviderConfig): EccoLanguageModelState => ({
  specificationVersion: 'v2',
  provider: 'ecco',
  modelId,
  defaultObjectGenerationMode: 'json',
  supportedUrls: {},
  config,
});

const waitForResponse = (
  nodeRef: StateRef<NodeState>,
  requestId: string,
  timeout: number
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Request timeout'));
      }
    }, timeout);

    subscribeToTopic(nodeRef, `response:${requestId}`, (data: unknown) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (typeof data === 'object' && data !== null && 'type' in data && data.type === 'message' && 'payload' in data) {
          resolve(data.payload);
        } else {
          resolve(data);
        }
      }
    });
  });

const parseResponse = (response: unknown): GenerateResult => {
  if (typeof response !== 'object' || response === null) {
    return {
      content: [],
      finishReason: 'error',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      warnings: [],
    };
  }

  const text = 'text' in response && typeof response.text === 'string' ? response.text : undefined;
  const finishReason = parseFinishReason('finishReason' in response ? response.finishReason : undefined);

  const rawUsage = 'usage' in response && typeof response.usage === 'object' && response.usage !== null
    ? response.usage
    : { promptTokens: 0, completionTokens: 0 };

  const promptTokens = 'promptTokens' in rawUsage && typeof rawUsage.promptTokens === 'number' ? rawUsage.promptTokens : 0;
  const completionTokens = 'completionTokens' in rawUsage && typeof rawUsage.completionTokens === 'number' ? rawUsage.completionTokens : 0;

  const warnings: LanguageModelV2CallWarning[] =
    'warnings' in response && Array.isArray(response.warnings) ? response.warnings : [];

  return {
    content: text ? [{ type: 'text', text }] : [],
    finishReason,
    usage: {
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
    warnings,
  };
};

const doGenerate = async (
  state: EccoLanguageModelState,
  options: LanguageModelV2CallOptions
): Promise<GenerateResult> => {
  const query: CapabilityQuery = {
    requiredCapabilities: [{ type: 'agent', name: state.modelId }],
  };

  const matches = await findPeers(state.config.nodeRef, query);

  if (matches.length === 0) {
    if (state.config.fallbackProvider) {
      return state.config.fallbackProvider.doGenerate(options);
    }
    throw new Error(`No peers found with capability: ${state.modelId}`);
  }

  const bestMatch = matches[0];
  const requestId = nanoid();

  const request = {
    id: requestId,
    from: getId(state.config.nodeRef),
    to: bestMatch.peer.id,
    type: 'agent-request' as const,
    payload: { model: state.modelId, options },
    timestamp: Date.now(),
  };

  await sendMessage(state.config.nodeRef, bestMatch.peer.id, request);

  const response = await waitForResponse(
    state.config.nodeRef,
    requestId,
    state.config.timeout || 30000
  );

  return parseResponse(response);
};

const doStream = async (
  state: EccoLanguageModelState,
  options: LanguageModelV2CallOptions
): Promise<StreamResult> => {
  const query: CapabilityQuery = {
    requiredCapabilities: [{ type: 'agent', name: state.modelId }],
  };

  const matches = await findPeers(state.config.nodeRef, query);

  if (matches.length === 0) {
    if (state.config.fallbackProvider) {
      return state.config.fallbackProvider.doStream(options);
    }
    throw new Error(`No peers found with capability: ${state.modelId}`);
  }

  const bestMatch = matches[0];
  const requestId = nanoid();

  subscribeToTopic(state.config.nodeRef, `response:${requestId}`, () => {});

  await sendMessage(state.config.nodeRef, bestMatch.peer.id, {
    id: requestId,
    from: getId(state.config.nodeRef),
    to: bestMatch.peer.id,
    type: 'agent-request' as const,
    payload: { model: state.modelId, prompt: options.prompt, stream: true },
    timestamp: Date.now(),
  });

  const stream = new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      subscribeToTopic(state.config.nodeRef, `response:${requestId}`, (data: unknown) => {
        if (typeof data === 'object' && data !== null && 'type' in data) {
          if (data.type === 'chunk' && 'text' in data && typeof data.text === 'string') {
            controller.enqueue({ type: 'text-delta', id: nanoid(), delta: data.text });
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
