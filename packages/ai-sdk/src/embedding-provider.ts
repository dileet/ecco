import { embed } from 'ai';
import type { EmbeddingModel } from 'ai';
import { subscribeToTopic, getId, publish, EmbeddingService, isEmbeddingRequest, type StateRef, type NodeState, type MessageEvent } from '@ecco/core';

export interface EmbeddingProviderConfig {
  nodeRef: StateRef<NodeState>;
  embeddingModel: EmbeddingModel<string>;
  modelId: string;
}

export function setupEmbeddingProvider(config: EmbeddingProviderConfig): void {
  const { nodeRef, embeddingModel, modelId } = config;

  subscribeToTopic(nodeRef, `peer:${getId(nodeRef)}`, async (event) => {
    if (event.type !== 'message') return;
    if (!isEmbeddingRequest(event.payload)) return;

    console.log(
      `[${getId(nodeRef)}] Received embedding request for ${event.payload.texts.length} texts`
    );

    try {
      const { texts, requestId } = event.payload;

      const CHUNK_SIZE = 32;

      for (let i = 0; i < texts.length; i++) {
        const { embedding } = await embed({
          model: embeddingModel,
          value: texts[i],
        });

        const plainEmbedding = Array.from(embedding);

        console.log(`[${getId(nodeRef)}] Embedding type: ${embedding.constructor.name}, length: ${plainEmbedding.length}`);
        console.log(`[${getId(nodeRef)}] First 5 values: ${plainEmbedding.slice(0, 5).join(', ')}`);

        const numChunks = Math.ceil(plainEmbedding.length / CHUNK_SIZE);

        for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
          const start = chunkIdx * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, plainEmbedding.length);
          const chunk = plainEmbedding.slice(start, end);

          const embeddingResponse = {
            type: 'embedding-response',
            requestId,
            embeddings: [chunk],
            index: i,
            total: texts.length,
            model: modelId,
            dimensions: plainEmbedding.length,
            chunkIndex: chunkIdx,
            totalChunks: numChunks,
          };

          const responseEvent: MessageEvent = {
            type: 'message',
            from: getId(nodeRef),
            to: event.from,
            payload: embeddingResponse,
            timestamp: Date.now(),
          };

          const serializedSize = JSON.stringify(embeddingResponse).length;
          console.log(`[${getId(nodeRef)}] Chunk ${chunkIdx}/${numChunks}: ${chunk.length} floats, serialized size: ${serializedSize} bytes`);

          const topic = `embedding-response:${requestId}`;
          await publish(nodeRef, topic, responseEvent);
          await publish(nodeRef, `peer:${event.from}`, responseEvent);

          if (chunkIdx < numChunks - 1) {
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        }

        console.log(
          `[${getId(nodeRef)}] Sent embedding ${i + 1}/${texts.length} in ${numChunks} chunks`
        );
      }

      console.log(
        `[${getId(nodeRef)}] Sent ${texts.length} embeddings`
      );

      EmbeddingService.updatePeerServiceProvided(nodeRef, event.from);
    } catch (error) {
      console.error(`[${getId(nodeRef)}] Embedding error:`, error);
    }
  });
}
