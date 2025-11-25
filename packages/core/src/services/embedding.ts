import { Effect } from 'effect';
import type { NodeState } from '../node/types';
import { Node } from '../node';
import { updatePeer } from '../node/state-helpers';
import type { CapabilityQuery, PeerInfo } from '../types';
import type { MessageEvent } from '../events';
import { recordSuccess, getMetrics, calculatePerformanceScore } from '../node/peer-performance';
import { isBlockedPeer } from '../node/bad-behavior-sketch';
import { incrementReputation } from '../registry-client';

export interface EmbeddingRequest {
  type: 'embedding-request';
  requestId: string;
  texts: string[];
  model?: string;
}

export interface EmbeddingResponse {
  type: 'embedding-response';
  requestId: string;
  embeddings: number[][];
  model: string;
  dimensions: number;
  index?: number;
  total?: number;
  chunkIndex?: number;
  totalChunks?: number;
}

export function isEmbeddingRequest(payload: unknown): payload is EmbeddingRequest {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'type' in payload &&
    payload.type === 'embedding-request'
  );
}

export function isEmbeddingResponse(payload: unknown): payload is EmbeddingResponse {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'type' in payload &&
    payload.type === 'embedding-response'
  );
}

export namespace EmbeddingService {
  export function shouldUsePeerForEmbedding(
    peer: PeerInfo,
    requireExchange: boolean
  ): boolean {
    if (!requireExchange) {
      return true;
    }

    const servicesProvided = peer.servicesProvided || 0;
    const servicesConsumed = peer.servicesConsumed || 0;

    return servicesProvided > servicesConsumed;
  }

  export const selectEmbeddingPeer = (
    nodeState: NodeState,
    peers: PeerInfo[],
    requireExchange: boolean
  ): Effect.Effect<PeerInfo | null, Error> =>
    Effect.gen(function* () {
      if (!nodeState.performanceTracker || !nodeState.badBehaviorTracker) {
        return null;
      }

      const filteredPeers: PeerInfo[] = [];
      for (const peer of peers) {
        const isBlocked = yield* isBlockedPeer(nodeState.badBehaviorTracker, peer.id);
        if (!isBlocked && shouldUsePeerForEmbedding(peer, requireExchange)) {
          filteredPeers.push(peer);
        }
      }

      if (filteredPeers.length === 0) {
        return null;
      }

      const peerScores: Array<{ peer: PeerInfo; score: number }> = [];
      for (const peer of filteredPeers) {
        const metrics = yield* getMetrics(nodeState.performanceTracker, peer.id);
        const performanceScore = metrics ? calculatePerformanceScore(metrics) : 0.5;
        const balance = (peer.servicesProvided || 0) - (peer.servicesConsumed || 0);
        const balanceScore = Math.max(0, Math.min(1, (balance + 10) / 20));
        const totalScore = performanceScore * 0.7 + balanceScore * 0.3;
        peerScores.push({ peer, score: totalScore });
      }

      peerScores.sort((a, b) => b.score - a.score);
      return peerScores[0]?.peer ?? null;
    });

  export const requestEmbeddings = (
    nodeState: NodeState,
    texts: string[],
    config: { requireExchange?: boolean; model?: string; preferredPeers?: string[] } = {}
  ): Effect.Effect<{ embeddings: number[][]; state: NodeState }, Error> =>
    Effect.gen(function* () {
      const query: CapabilityQuery = {
        requiredCapabilities: [{ type: 'embedding' }],
        preferredPeers: config.preferredPeers,
      };

      const { matches, state: updatedNodeState } = yield* Effect.promise(() =>
        Node.findPeers(nodeState, query)
      );

      // If discovery didn't find any peers but a preferred peerId was given,
      // fall back to direct request to that peer's topic.
      if (matches.length === 0 && config.preferredPeers && config.preferredPeers.length > 0) {
        const targetPeerId = config.preferredPeers[0]!;

        const requestId = `embedding-${Date.now()}`;
        const request: EmbeddingRequest = {
          type: 'embedding-request',
          requestId,
          texts,
          model: config.model,
        };

        const responsePromise = new Promise<EmbeddingResponse>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Embedding request timeout'));
          }, 30000);

          const collectedEmbeddings: number[][] = [];
          // Default to requested count; providers may omit 'total'
          let expectedTotal = texts.length;

          const chunksByEmbedding = new Map<number, Map<number, number[]>>();
          const expectedChunks = new Map<number, number>();
          const fullDimensions = new Map<number, number>();

          const stateWithSub = Node.subscribeToTopic(
            updatedNodeState,
            `embedding-response:${requestId}`,
            (event) => {
              if (event.type === 'message' && isEmbeddingResponse(event.payload)) {
                const response = event.payload;

                if (response.total !== undefined) {
                  expectedTotal = response.total;
                }

                const embeddingIndex = response.index ?? 0;

                if (response.chunkIndex !== undefined && response.totalChunks !== undefined) {
                  if (!chunksByEmbedding.has(embeddingIndex)) {
                    chunksByEmbedding.set(embeddingIndex, new Map());
                    expectedChunks.set(embeddingIndex, response.totalChunks);
                    fullDimensions.set(embeddingIndex, response.dimensions);
                  }

                  const chunks = chunksByEmbedding.get(embeddingIndex)!;
                  chunks.set(response.chunkIndex, response.embeddings[0]);

                  if (chunks.size === expectedChunks.get(embeddingIndex)) {
                    const fullEmbedding: number[] = [];
                    for (let i = 0; i < chunks.size; i++) {
                      fullEmbedding.push(...chunks.get(i)!);
                    }
                    collectedEmbeddings[embeddingIndex] = fullEmbedding;
                  }
                } else {
                  if (response.index !== undefined && response.embeddings[0]) {
                    collectedEmbeddings[response.index] = response.embeddings[0];
                  } else {
                    collectedEmbeddings.push(...response.embeddings);
                  }
                }

                const allComplete = collectedEmbeddings.filter(e => e !== undefined).length;
                if (expectedTotal > 0 && allComplete >= expectedTotal) {
                  clearTimeout(timeout);
                  resolve({
                    type: 'embedding-response',
                    requestId,
                    embeddings: collectedEmbeddings,
                    model: response.model,
                    dimensions: response.dimensions,
                  });
                }
              }
            }
          );

          // Also listen on our peer topic in case provider replies there
          const stateWithPeerSub = Node.subscribeToTopic(
            stateWithSub,
            `peer:${Node.getId(updatedNodeState)}`,
            (event) => {
              if (event.type === 'message' && isEmbeddingResponse(event.payload) && event.payload.requestId === requestId) {
                const response = event.payload;

                if (response.total !== undefined) {
                  expectedTotal = response.total;
                }

                const embeddingIndex = response.index ?? 0;

                if (response.chunkIndex !== undefined && response.totalChunks !== undefined) {
                  if (!chunksByEmbedding.has(embeddingIndex)) {
                    chunksByEmbedding.set(embeddingIndex, new Map());
                    expectedChunks.set(embeddingIndex, response.totalChunks);
                    fullDimensions.set(embeddingIndex, response.dimensions);
                  }

                  const chunks = chunksByEmbedding.get(embeddingIndex)!;
                  chunks.set(response.chunkIndex, response.embeddings[0]);

                  if (chunks.size === expectedChunks.get(embeddingIndex)) {
                    const fullEmbedding: number[] = [];
                    for (let i = 0; i < chunks.size; i++) {
                      fullEmbedding.push(...chunks.get(i)!);
                    }
                    collectedEmbeddings[embeddingIndex] = fullEmbedding;
                  }
                } else {
                  if (response.index !== undefined && response.embeddings[0]) {
                    collectedEmbeddings[response.index] = response.embeddings[0];
                  } else {
                    collectedEmbeddings.push(...response.embeddings);
                  }
                }

                const allComplete = collectedEmbeddings.filter(e => e !== undefined).length;
                if (expectedTotal > 0 && allComplete >= expectedTotal) {
                  clearTimeout(timeout);
                  resolve({
                    type: 'embedding-response',
                    requestId,
                    embeddings: collectedEmbeddings,
                    model: response.model,
                    dimensions: response.dimensions,
                  });
                }
              }
            }
          );

          const messageEvent: MessageEvent = {
            type: 'message',
            from: Node.getId(stateWithPeerSub),
            to: targetPeerId,
            payload: request,
            timestamp: Date.now(),
          };
          Node.publish(stateWithPeerSub, `peer:${targetPeerId}`, messageEvent);
        });

        const startTime = Date.now();
        const response = yield* Effect.tryPromise({
          try: () => responsePromise,
          catch: (error) => new Error(`Embedding request failed: ${error}`),
        });
        const latency = Date.now() - startTime;

        const existing = updatedNodeState.peers.get(targetPeerId);
        const newPeers = new Map(updatedNodeState.peers);
        if (existing) {
          newPeers.set(targetPeerId, {
            ...existing,
            servicesConsumed: (existing.servicesConsumed || 0) + 1,
            lastSeen: Date.now(),
          });
        } else {
          newPeers.set(targetPeerId, {
            id: targetPeerId,
            addresses: [],
            capabilities: [],
            lastSeen: Date.now(),
            servicesConsumed: 1,
          });
        }
        const finalState = { ...updatedNodeState, peers: newPeers };

        if (finalState.performanceTracker) {
          const throughput = texts.length / (latency / 1000);
          yield* recordSuccess(finalState.performanceTracker, targetPeerId, latency, throughput);
        }

        if (finalState.registryClient?.connected) {
          yield* Effect.tryPromise({
            try: () => incrementReputation(finalState.registryClient!, targetPeerId, 1),
            catch: () => new Error('Failed to update reputation'),
          }).pipe(Effect.catchAll(() => Effect.succeed(void 0)));
        }

        return { embeddings: response.embeddings, state: finalState };
      }

      if (matches.length === 0) {
        return yield* Effect.fail(new Error('No embedding-capable peers found'));
      }

      const selectedPeer = yield* selectEmbeddingPeer(
        updatedNodeState,
        matches.map(m => m.peer),
        config.requireExchange || false
      );

      if (!selectedPeer) {
        return yield* Effect.fail(
          new Error('No eligible embedding peers (check service exchange balance)')
        );
      }

      const requestId = `embedding-${Date.now()}`;
      const request: EmbeddingRequest = {
        type: 'embedding-request',
        requestId,
        texts,
        model: config.model,
      };

      const responsePromise = new Promise<EmbeddingResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Embedding request timeout'));
        }, 30000);

        const collectedEmbeddings: number[][] = [];
        // Default to requested count; providers may omit 'total'
        let expectedTotal = texts.length;

        // Track chunks for reassembly: Map<embeddingIndex, Map<chunkIndex, chunk>>
        const chunksByEmbedding = new Map<number, Map<number, number[]>>();
        const expectedChunks = new Map<number, number>();
        const fullDimensions = new Map<number, number>();

        const stateWithSub = Node.subscribeToTopic(
          updatedNodeState,
          `embedding-response:${requestId}`,
          (event) => {
            if (event.type === 'message' && isEmbeddingResponse(event.payload)) {
              const response = event.payload;

              if (response.total !== undefined) {
                expectedTotal = response.total;
              }

              const embeddingIndex = response.index ?? 0;

              // Handle chunked embeddings
              if (response.chunkIndex !== undefined && response.totalChunks !== undefined) {
                if (!chunksByEmbedding.has(embeddingIndex)) {
                  chunksByEmbedding.set(embeddingIndex, new Map());
                  expectedChunks.set(embeddingIndex, response.totalChunks);
                  fullDimensions.set(embeddingIndex, response.dimensions);
                }

                const chunks = chunksByEmbedding.get(embeddingIndex)!;
                chunks.set(response.chunkIndex, response.embeddings[0]);

                // Check if all chunks received for this embedding
                if (chunks.size === expectedChunks.get(embeddingIndex)) {
                  // Reassemble chunks in order
                  const fullEmbedding: number[] = [];
                  for (let i = 0; i < chunks.size; i++) {
                    fullEmbedding.push(...chunks.get(i)!);
                  }
                  collectedEmbeddings[embeddingIndex] = fullEmbedding;
                }
              } else {
                // Non-chunked (backward compatibility)
                if (response.index !== undefined && response.embeddings[0]) {
                  collectedEmbeddings[response.index] = response.embeddings[0];
                } else {
                  collectedEmbeddings.push(...response.embeddings);
                }
              }

              // Check if all embeddings complete
              const allComplete = collectedEmbeddings.filter(e => e !== undefined).length;
              if (expectedTotal > 0 && allComplete >= expectedTotal) {
                clearTimeout(timeout);
                resolve({
                  type: 'embedding-response',
                  requestId,
                  embeddings: collectedEmbeddings,
                  model: response.model,
                  dimensions: response.dimensions,
                });
              }
            }
          }
        );

        // Fallback: also listen on our peer topic for responses that may be routed directly
        const stateWithPeerSub = Node.subscribeToTopic(
          stateWithSub,
          `peer:${Node.getId(updatedNodeState)}`,
          (event) => {
            if (event.type === 'message' && isEmbeddingResponse(event.payload) && event.payload.requestId === requestId) {
              const response = event.payload;

              if (response.total !== undefined) {
                expectedTotal = response.total;
              }

              const embeddingIndex = response.index ?? 0;

              if (response.chunkIndex !== undefined && response.totalChunks !== undefined) {
                if (!chunksByEmbedding.has(embeddingIndex)) {
                  chunksByEmbedding.set(embeddingIndex, new Map());
                  expectedChunks.set(embeddingIndex, response.totalChunks);
                  fullDimensions.set(embeddingIndex, response.dimensions);
                }

                const chunks = chunksByEmbedding.get(embeddingIndex)!;
                chunks.set(response.chunkIndex, response.embeddings[0]);

                if (chunks.size === expectedChunks.get(embeddingIndex)) {
                  const fullEmbedding: number[] = [];
                  for (let i = 0; i < chunks.size; i++) {
                    fullEmbedding.push(...chunks.get(i)!);
                  }
                  collectedEmbeddings[embeddingIndex] = fullEmbedding;
                }
              } else {
                if (response.index !== undefined && response.embeddings[0]) {
                  collectedEmbeddings[response.index] = response.embeddings[0];
                } else {
                  collectedEmbeddings.push(...response.embeddings);
                }
              }

              const allComplete = collectedEmbeddings.filter(e => e !== undefined).length;
              if (expectedTotal > 0 && allComplete >= expectedTotal) {
                clearTimeout(timeout);
                resolve({
                  type: 'embedding-response',
                  requestId,
                  embeddings: collectedEmbeddings,
                  model: response.model,
                  dimensions: response.dimensions,
                });
              }
            }
          }
        );

        const messageEvent: MessageEvent = {
          type: 'message',
          from: Node.getId(stateWithSub),
          to: selectedPeer.id,
          payload: request,
          timestamp: Date.now(),
        };
        Node.publish(stateWithPeerSub, `peer:${selectedPeer.id}`, messageEvent);
      });

      const startTime = Date.now();
      const response = yield* Effect.tryPromise({
        try: () => responsePromise,
        catch: (error) => new Error(`Embedding request failed: ${error}`),
      });
      const latency = Date.now() - startTime;

      const finalState = updatePeer(updatedNodeState, selectedPeer.id, {
        servicesConsumed: (selectedPeer.servicesConsumed || 0) + 1,
      });

      if (finalState.performanceTracker) {
        const throughput = texts.length / (latency / 1000);
        yield* recordSuccess(finalState.performanceTracker, selectedPeer.id, latency, throughput);
      }

      if (finalState.registryClient && isRegistryConnected(finalState.registryClient)) {
        yield* Effect.tryPromise({
          try: () => incrementReputation(finalState.registryClient!, selectedPeer.id, 1),
          catch: () => new Error('Failed to update reputation'),
        }).pipe(Effect.catchAll(() => Effect.succeed(void 0)));
      }

      return { embeddings: response.embeddings, state: finalState };
    });

  export function updatePeerServiceProvided(nodeState: NodeState, peerId: string): NodeState {
    const peer = Node.getPeers(nodeState).find(p => p.id === peerId);
    if (!peer) {
      return nodeState;
    }

    return updatePeer(nodeState, peerId, {
      servicesProvided: (peer.servicesProvided || 0) + 1,
    });
  }
}
