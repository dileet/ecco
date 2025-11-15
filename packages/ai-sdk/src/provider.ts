import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
  LanguageModelV2CallWarning,
  LanguageModelV2FinishReason,
  LanguageModelV2Content,
  LanguageModelV2Usage,
} from '@ai-sdk/provider';
import { Node, type NodeState, type CapabilityQuery } from '@ecco/core';
import { nanoid } from 'nanoid';

interface EccoProviderConfig {
  nodeState: NodeState;
  fallbackProvider?: LanguageModelV2;
  timeout?: number;
}

export class EccoLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'ecco';
  readonly modelId: string;
  readonly defaultObjectGenerationMode = 'json' as const;
  readonly supportedUrls = {} as const;

  private config: EccoProviderConfig;

  constructor(
    modelId: string,
    config: EccoProviderConfig
  ) {
    this.modelId = modelId;
    this.config = config;
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<{
    content: LanguageModelV2Content[];
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    warnings: LanguageModelV2CallWarning[];
  }> {
    const query: CapabilityQuery = {
      requiredCapabilities: [
        {
          type: 'agent',
          name: this.modelId,
        },
      ],
    };

    const { matches, state: updatedState } = await Node.findPeers(this.config.nodeState, query);
    this.config.nodeState = updatedState;

    if (matches.length === 0) {
      if (this.config.fallbackProvider) {
        console.log('No peers found, falling back to local provider');
        return this.config.fallbackProvider.doGenerate(options);
      }
      throw new Error(`No peers found with capability: ${this.modelId}`);
    }

    const bestMatch = matches[0];
    console.log(`Using peer ${bestMatch.peer.id} for inference`);

    const requestId = nanoid();
    const request = {
      id: requestId,
      from: Node.getId(this.config.nodeState),
      to: bestMatch.peer.id,
      type: 'agent-request' as const,
      payload: {
        model: this.modelId,
        options: options,
      },
      timestamp: Date.now(),
    };

    this.config.nodeState = await Node.sendMessage(this.config.nodeState, bestMatch.peer.id, request);

    // Wait for response (with timeout)
    const response = await this.waitForResponse(
      requestId,
      this.config.timeout || 30000
    );

    if (typeof response !== 'object' || response === null) {
      throw new Error('Invalid response from peer');
    }

    const text = 'text' in response && typeof response.text === 'string' ? response.text : undefined;

    let finishReason: LanguageModelV2FinishReason = 'stop';
    if ('finishReason' in response && typeof response.finishReason === 'string') {
      if (
        response.finishReason === 'stop' ||
        response.finishReason === 'length' ||
        response.finishReason === 'content-filter' ||
        response.finishReason === 'tool-calls' ||
        response.finishReason === 'error' ||
        response.finishReason === 'other' ||
        response.finishReason === 'unknown'
      ) {
        finishReason = response.finishReason;
      }
    }

    const usage = 'usage' in response && typeof response.usage === 'object' && response.usage !== null
      ? response.usage
      : { promptTokens: 0, completionTokens: 0 };

    const promptTokens = 'promptTokens' in usage && typeof usage.promptTokens === 'number' ? usage.promptTokens : 0;
    const completionTokens = 'completionTokens' in usage && typeof usage.completionTokens === 'number' ? usage.completionTokens : 0;

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
  }

  async doStream(options: LanguageModelV2CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>;
  }> {
    const query: CapabilityQuery = {
      requiredCapabilities: [
        {
          type: 'agent',
          name: this.modelId,
        },
      ],
    };

    const { matches, state: updatedState } = await Node.findPeers(this.config.nodeState, query);
    this.config.nodeState = updatedState;

    if (matches.length === 0) {
      if (this.config.fallbackProvider) {
        console.log('No peers found, falling back to local provider');
        return this.config.fallbackProvider.doStream(options);
      }
      throw new Error(`No peers found with capability: ${this.modelId}`);
    }

    const bestMatch = matches[0];
    const requestId = nanoid();

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start: async (controller) => {
        this.config.nodeState = Node.subscribeToTopic(this.config.nodeState, `response:${requestId}`, (data: unknown) => {
          if (typeof data === 'object' && data !== null && 'type' in data) {
            if (data.type === 'chunk' && 'text' in data && typeof data.text === 'string') {
              controller.enqueue({
                type: 'text-delta',
                id: nanoid(),
                delta: data.text,
              });
            } else if (data.type === 'done') {
              let finishReason: LanguageModelV2FinishReason = 'stop';
              if ('finishReason' in data && typeof data.finishReason === 'string') {
                if (
                  data.finishReason === 'stop' ||
                  data.finishReason === 'length' ||
                  data.finishReason === 'content-filter' ||
                  data.finishReason === 'tool-calls' ||
                  data.finishReason === 'error' ||
                  data.finishReason === 'other' ||
                  data.finishReason === 'unknown'
                ) {
                  finishReason = data.finishReason;
                }
              }

              let usage: LanguageModelV2Usage = {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
              };

              if ('usage' in data && typeof data.usage === 'object' && data.usage !== null) {
                const usageObj = data.usage;
                const inputTokens = 'inputTokens' in usageObj && typeof usageObj.inputTokens === 'number' ? usageObj.inputTokens : 0;
                const outputTokens = 'outputTokens' in usageObj && typeof usageObj.outputTokens === 'number' ? usageObj.outputTokens : 0;
                usage = {
                  inputTokens,
                  outputTokens,
                  totalTokens: inputTokens + outputTokens,
                };
              }

              controller.enqueue({
                type: 'finish',
                finishReason,
                usage,
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
            prompt: options.prompt,
            stream: true,
          },
          timestamp: Date.now(),
        });
      },
    });

    return {
      stream,
    };
  }

  private async waitForResponse(requestId: string, timeout: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Request timeout'));
        }
      }, timeout);

      Node.subscribeToTopic(this.config.nodeState, `response:${requestId}`, (data: unknown) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          // Extract payload from event if it's a message event
          if (typeof data === 'object' && data !== null && 'type' in data && data.type === 'message' && 'payload' in data) {
            resolve(data.payload);
          } else {
            resolve(data);
          }
        }
      });
    });
  }
}

export function createEccoProvider(config: EccoProviderConfig) {
  return {
    languageModel: (modelId: string) => new EccoLanguageModel(modelId, config),
  };
}
