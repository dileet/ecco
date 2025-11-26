import { embed } from 'ai';
import type { EmbeddingModel } from 'ai';
import {
  subscribeToTopic,
  getId,
  publish,
  updatePeerServiceProvided,
  EmbeddingRequestSchema,
  MessageEventSchema,
  type StateRef,
  type NodeState,
  type MessageEvent,
} from '@ecco/core';

interface EmbeddingProviderConfig {
  nodeRef: StateRef<NodeState>;
  embeddingModel: EmbeddingModel<string>;
  modelId: string;
}

// Chunk size: 32 floats = ~350 bytes JSON (safe for Bun's ChaCha20)
const CHUNK_SIZE = 32;

// Split embedding into chunks to avoid Bun ChaCha20 cipher size limits
const chunkArray = <T>(array: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
};

const createResponseEvent = (
  nodeRef: StateRef<NodeState>,
  from: string,
  requestId: string,
  chunk: number[],
  index: number,
  total: number,
  modelId: string,
  dimensions: number,
  chunkIndex: number,
  totalChunks: number
): MessageEvent => ({
  type: 'message',
  from: getId(nodeRef),
  to: from,
  payload: {
    type: 'embedding-response',
    requestId,
    embeddings: [chunk],
    index,
    total,
    model: modelId,
    dimensions,
    chunkIndex,
    totalChunks,
  },
  timestamp: Date.now(),
});

const processEmbeddingRequest = async (
  config: EmbeddingProviderConfig,
  event: MessageEvent,
  texts: string[],
  requestId: string
): Promise<void> => {
  const { nodeRef, embeddingModel, modelId } = config;

  for (let i = 0; i < texts.length; i++) {
    const { embedding } = await embed({ model: embeddingModel, value: texts[i] });
    const plainEmbedding = Array.from(embedding);
    const chunks = chunkArray(plainEmbedding, CHUNK_SIZE);

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const responseEvent = createResponseEvent(
        nodeRef,
        event.from,
        requestId,
        chunks[chunkIdx],
        i,
        texts.length,
        modelId,
        plainEmbedding.length,
        chunkIdx,
        chunks.length
      );

      await publish(nodeRef, `embedding-response:${requestId}`, responseEvent);
      await publish(nodeRef, `peer:${event.from}`, responseEvent);

      // Small delay between chunks to avoid overwhelming transport (Bun ChaCha20 limit)
      if (chunkIdx < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }

  updatePeerServiceProvided(nodeRef, event.from);
};

function setupEmbeddingProvider(config: EmbeddingProviderConfig): void {
  const { nodeRef } = config;

  subscribeToTopic(nodeRef, `peer:${getId(nodeRef)}`, async (event) => {
    const messageEvent = MessageEventSchema.safeParse(event);
    if (!messageEvent.success) return;

    const request = EmbeddingRequestSchema.safeParse(messageEvent.data.payload);
    if (!request.success) return;

    try {
      await processEmbeddingRequest(config, messageEvent.data, request.data.texts, request.data.requestId);
    } catch (error) {
      console.error(`[${getId(nodeRef)}] Embedding error:`, error);
    }
  });
}

export { setupEmbeddingProvider, type EmbeddingProviderConfig };
