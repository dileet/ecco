import { embed } from 'ai';
import type { EmbeddingModel } from 'ai';
import {
  subscribeToTopic,
  getId,
  publish,
  updatePeerServiceProvided,
  registerCleanup,
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
  libp2pPeerId?: string;
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

const createBatchedResponseEvent = (
  nodeRef: StateRef<NodeState>,
  from: string,
  requestId: string,
  chunks: number[][],
  index: number,
  total: number,
  modelId: string,
  dimensions: number
): MessageEvent => {
  const fullEmbedding: number[] = [];
  for (const chunk of chunks) {
    fullEmbedding.push(...chunk);
  }

  return {
    type: 'message',
    from: getId(nodeRef),
    to: from,
    payload: {
      type: 'embedding-response',
      requestId,
      embeddings: [fullEmbedding],
      index,
      total,
      model: modelId,
      dimensions,
    },
    timestamp: Date.now(),
  };
};

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

    const responseEvent = createBatchedResponseEvent(
      nodeRef,
      event.from,
      requestId,
      chunks,
      i,
      texts.length,
      modelId,
      plainEmbedding.length
    );

    await publish(nodeRef, `peer:${event.from}`, responseEvent);
  }

  updatePeerServiceProvided(nodeRef, event.from);
};

function setupEmbeddingProvider(config: EmbeddingProviderConfig): void {
  const { nodeRef, libp2pPeerId } = config;

  const handleEmbeddingRequest = async (event: unknown): Promise<void> => {
    const messageEvent = MessageEventSchema.safeParse(event);
    if (!messageEvent.success) return;

    const request = EmbeddingRequestSchema.safeParse(messageEvent.data.payload);
    if (!request.success) return;

    try {
      await processEmbeddingRequest(config, messageEvent.data, request.data.texts, request.data.requestId);
    } catch (error) {
      console.error(`[${getId(nodeRef)}] Embedding error:`, error);
    }
  };

  const unsubscribe1 = subscribeToTopic(nodeRef, `peer:${getId(nodeRef)}`, handleEmbeddingRequest);
  registerCleanup(nodeRef, unsubscribe1);

  if (libp2pPeerId) {
    const unsubscribe2 = subscribeToTopic(nodeRef, `peer:${libp2pPeerId}`, handleEmbeddingRequest);
    registerCleanup(nodeRef, unsubscribe2);
  }
}

export { setupEmbeddingProvider, type EmbeddingProviderConfig };
