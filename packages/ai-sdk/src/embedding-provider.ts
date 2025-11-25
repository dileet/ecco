import { embed } from 'ai';
import type { EmbeddingModel } from 'ai';
import { Node, EmbeddingService, isEmbeddingRequest, type NodeState, type MessageEvent } from '@ecco/core';

export interface EmbeddingProviderConfig {
  nodeState: NodeState;
  embeddingModel: EmbeddingModel<string>;
  modelId: string;
}

export function setupEmbeddingProvider(config: EmbeddingProviderConfig): NodeState {
  const { nodeState, embeddingModel, modelId } = config;

  const updatedState = Node.subscribeToTopic(
    nodeState,
    `peer:${Node.getId(nodeState)}`,
    async (event) => {
      if (event.type !== 'message') return;
      if (!isEmbeddingRequest(event.payload)) return;

      console.log(
        `[${Node.getId(nodeState)}] Received embedding request for ${event.payload.texts.length} texts`
      );

      try {
        const { texts, requestId } = event.payload;

        // Chunk size: 32 floats = ~350 bytes JSON (safe for Bun's ChaCha20)
        const CHUNK_SIZE = 32;

        for (let i = 0; i < texts.length; i++) {
          const { embedding } = await embed({
            model: embeddingModel,
            value: texts[i],
          });

          // Convert to plain array (OpenAI may return TypedArray which doesn't serialize well)
          const plainEmbedding = Array.from(embedding);

          console.log(`[${Node.getId(nodeState)}] Embedding type: ${embedding.constructor.name}, length: ${plainEmbedding.length}`);
          console.log(`[${Node.getId(nodeState)}] First 5 values: ${plainEmbedding.slice(0, 5).join(', ')}`);

          // Split embedding into chunks to avoid Bun ChaCha20 cipher size limits
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
              from: Node.getId(nodeState),
              to: event.from,
              payload: embeddingResponse,
              timestamp: Date.now(),
            };

            const serializedSize = JSON.stringify(embeddingResponse).length;
            console.log(`[${Node.getId(nodeState)}] Chunk ${chunkIdx}/${numChunks}: ${chunk.length} floats, serialized size: ${serializedSize} bytes`);

            const topic = `embedding-response:${requestId}`;
            await Node.publish(nodeState, topic, responseEvent);
            // Also publish directly to the requester's peer topic for reliability
            await Node.publish(nodeState, `peer:${event.from}`, responseEvent);

            // Small delay between chunks to avoid overwhelming transport
            if (chunkIdx < numChunks - 1) {
              await new Promise(resolve => setTimeout(resolve, 5));
            }
          }

          console.log(
            `[${Node.getId(nodeState)}] Sent embedding ${i + 1}/${texts.length} in ${numChunks} chunks`
          );
        }

        console.log(
          `[${Node.getId(nodeState)}] Sent ${texts.length} embeddings`
        );

        EmbeddingService.updatePeerServiceProvided(nodeState, event.from);
      } catch (error) {
        console.error(`[${Node.getId(nodeState)}] Embedding error:`, error);
      }
    }
  );

  return updatedState;
}
