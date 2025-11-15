import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';

export interface AgentRequestPayload {
  model: string;
  options: LanguageModelV2CallOptions;
  stream?: boolean;
}

export interface AgentResponsePayload {
  text?: string;
  finishReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  error?: string;
}

export function isAgentRequest(message: unknown): message is {
  type: 'agent-request';
  id: string;
  payload: AgentRequestPayload;
} {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  if (!('type' in message) || message.type !== 'agent-request') {
    return false;
  }

  if (!('id' in message) || typeof message.id !== 'string') {
    return false;
  }

  if (!('payload' in message) || typeof message.payload !== 'object' || message.payload === null) {
    return false;
  }

  const payload = message.payload;

  if (!('model' in payload) || typeof payload.model !== 'string') {
    return false;
  }

  if (!('options' in payload) || typeof payload.options !== 'object' || payload.options === null) {
    return false;
  }

  return true;
}
