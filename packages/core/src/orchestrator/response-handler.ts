import type { Message } from '../types';
import { z } from 'zod';

const MAX_STREAM_BUFFER_BYTES = 10 * 1024 * 1024;

const StreamChunkPayloadSchema = z.object({
  requestId: z.string(),
  chunk: z.string(),
  partial: z.boolean().optional(),
});

const StreamCompletePayloadSchema = z.object({
  requestId: z.string(),
  text: z.string(),
  complete: z.boolean().optional(),
});

const MAX_STREAM_CHUNKS = 4096;

type ResponseResolver = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
};

type StreamBuffer = {
  text: string;
  bytes: number;
  chunks: number;
};

export type ResponseHandlerConfig = {
  timeout: number;
  maxStreamBufferBytes?: number;
  maxStreamChunks?: number;
  onStream?: (chunk: { text: string; peerId: string }) => void;
};

export type ResponseHandler = {
  addPendingRequest: (requestId: string) => Promise<unknown>;
  handleMessage: (message: Message) => void;
  getPromise: (requestId: string) => Promise<unknown> | undefined;
  rejectRequest: (requestId: string, error: Error) => void;
  cleanup: () => void;
};

export const createResponseHandler = (config: ResponseHandlerConfig): ResponseHandler => {
  const responsePromises = new Map<string, Promise<unknown>>();
  const responseResolvers = new Map<string, ResponseResolver>();
  const timeoutIds = new Map<string, ReturnType<typeof setTimeout>>();
  const streamBuffers = new Map<string, StreamBuffer>();

  const maxStreamBufferBytes = config.maxStreamBufferBytes ?? MAX_STREAM_BUFFER_BYTES;
  const maxStreamChunks = config.maxStreamChunks ?? MAX_STREAM_CHUNKS;

  const takeResolver = (requestId: string): ResponseResolver | undefined => {
    const resolver = responseResolvers.get(requestId);
    if (!resolver) return undefined;
    responseResolvers.delete(requestId);
    return resolver;
  };

  const finalizeRequest = (requestId: string) => {
    const timeoutId = timeoutIds.get(requestId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutIds.delete(requestId);
    }
    streamBuffers.delete(requestId);
  };

  const addPendingRequest = (requestId: string): Promise<unknown> => {
    const promise = new Promise<unknown>((resolve, reject) => {
      responseResolvers.set(requestId, { resolve, reject });

      const timeoutId = setTimeout(() => {
        const resolver = takeResolver(requestId);
        if (resolver) {
          resolver.reject(new Error(`Response timeout after ${config.timeout}ms`));
          finalizeRequest(requestId);
        }
      }, config.timeout);

      timeoutIds.set(requestId, timeoutId);
    });

    responsePromises.set(requestId, promise);
    streamBuffers.set(requestId, { text: '', bytes: 0, chunks: 0 });
    return promise;
  };

  const handleStreamChunk = (message: Message) => {
    const parsed = StreamChunkPayloadSchema.safeParse(message.payload);
    if (!parsed.success) return;

    const buffer = streamBuffers.get(parsed.data.requestId);
    if (buffer) {
      const chunkBytes = Buffer.byteLength(parsed.data.chunk);
      const nextBytes = buffer.bytes + chunkBytes;
      const nextChunks = buffer.chunks + 1;

      if (nextBytes > maxStreamBufferBytes || nextChunks > maxStreamChunks) {
        const resolver = takeResolver(parsed.data.requestId);
        if (resolver) {
          resolver.reject(new Error('Stream exceeded maximum size'));
          finalizeRequest(parsed.data.requestId);
        }
        return;
      }

      streamBuffers.set(parsed.data.requestId, {
        text: buffer.text + parsed.data.chunk,
        bytes: nextBytes,
        chunks: nextChunks,
      });
    }

    if (config.onStream) {
      config.onStream({ text: parsed.data.chunk, peerId: message.from });
    }
  };

  const handleStreamComplete = (message: Message) => {
    const parsed = StreamCompletePayloadSchema.safeParse(message.payload);
    if (!parsed.success) return;

    const buffer = streamBuffers.get(parsed.data.requestId);
    const bufferedText = buffer ? buffer.text : parsed.data.text;
    const totalBytes = buffer ? buffer.bytes : Buffer.byteLength(parsed.data.text);
    const totalChunks = buffer ? buffer.chunks : 1;

    const resolver = takeResolver(parsed.data.requestId);
    if (resolver) {
      finalizeRequest(parsed.data.requestId);
      if (totalBytes > maxStreamBufferBytes || totalChunks > maxStreamChunks) {
        resolver.reject(new Error('Stream exceeded maximum size'));
      } else {
        resolver.resolve({ text: bufferedText });
      }
    }
  };

  const handleAgentResponse = (message: Message) => {
    const responsePayload = message.payload as { requestId?: string; response?: unknown; error?: string };
    const msgRequestId = responsePayload?.requestId ?? message.id;

    const resolver = takeResolver(msgRequestId);
    if (resolver) {
      finalizeRequest(msgRequestId);
      if (responsePayload?.error) {
        resolver.reject(new Error(responsePayload.error));
      } else {
        resolver.resolve(responsePayload?.response ?? message.payload);
      }
    }
  };

  const handleMessage = (message: Message) => {
    switch (message.type) {
      case 'stream-chunk':
        handleStreamChunk(message);
        break;
      case 'stream-complete':
        handleStreamComplete(message);
        break;
      case 'agent-response':
        handleAgentResponse(message);
        break;
    }
  };

  return {
    addPendingRequest,
    handleMessage,
    getPromise: (requestId: string) => responsePromises.get(requestId),
    rejectRequest: (requestId: string, error: Error) => {
      const resolver = takeResolver(requestId);
      if (resolver) {
        finalizeRequest(requestId);
        resolver.reject(error);
      }
    },
    cleanup: () => {
      for (const timeoutId of timeoutIds.values()) {
        clearTimeout(timeoutId);
      }
      timeoutIds.clear();
      streamBuffers.clear();
      responseResolvers.clear();
      responsePromises.clear();
    },
  };
};
