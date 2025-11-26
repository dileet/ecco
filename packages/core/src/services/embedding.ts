import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { NodeState, StateRef } from '../node/types';
import { subscribeToTopic, getId, publish, findPeers, getPeers, getState, setState } from '../node';
import type { CapabilityQuery, PeerInfo } from '../types';
import type { MessageEvent } from '../events';

export const EmbeddingRequestSchema = z.object({
  type: z.literal('embedding-request'),
  requestId: z.string(),
  texts: z.array(z.string()),
  model: z.string().optional(),
});

export const EmbeddingResponseSchema = z.object({
  type: z.literal('embedding-response'),
  requestId: z.string(),
  embeddings: z.array(z.array(z.number())),
  model: z.string(),
  dimensions: z.number(),
  index: z.number().optional(),
  total: z.number().optional(),
  chunkIndex: z.number().optional(),
  totalChunks: z.number().optional(),
});

export type EmbeddingRequest = z.infer<typeof EmbeddingRequestSchema>;
export type EmbeddingResponse = z.infer<typeof EmbeddingResponseSchema>;

export function shouldUsePeerForEmbedding(peer: PeerInfo, requireExchange: boolean): boolean {
  if (!requireExchange) {
    return true;
  }
  const servicesProvided = peer.servicesProvided || 0;
  const servicesConsumed = peer.servicesConsumed || 0;
  return servicesProvided > servicesConsumed;
}

function calculatePeerScore(peer: PeerInfo): number {
  const balance = (peer.servicesProvided || 0) - (peer.servicesConsumed || 0);
  const balanceScore = Math.max(0, Math.min(1, (balance + 10) / 20));
  const reputationScore = peer.reputation ? Math.min(1, peer.reputation / 100) : 0.5;
  return reputationScore * 0.7 + balanceScore * 0.3;
}

export function selectEmbeddingPeer(
  peers: PeerInfo[],
  requireExchange: boolean
): PeerInfo | null {
  const filteredPeers = peers.filter((peer) => shouldUsePeerForEmbedding(peer, requireExchange));

  if (filteredPeers.length === 0) {
    return null;
  }

  const peerScores = filteredPeers.map((peer) => ({
    peer,
    score: calculatePeerScore(peer),
  }));

  peerScores.sort((a, b) => b.score - a.score);
  return peerScores[0]?.peer ?? null;
}

interface ResponseCollectorState {
  collectedEmbeddings: number[][];
  expectedTotal: number;
  chunksByEmbedding: Map<number, Map<number, number[]>>;
  expectedChunks: Map<number, number>;
  fullDimensions: Map<number, number>;
}

function createResponseCollectorState(textCount: number): ResponseCollectorState {
  return {
    collectedEmbeddings: [],
    expectedTotal: textCount,
    chunksByEmbedding: new Map(),
    expectedChunks: new Map(),
    fullDimensions: new Map(),
  };
}

function processEmbeddingResponse(
  state: ResponseCollectorState,
  response: EmbeddingResponse
): { complete: boolean; embeddings: number[][] } {
  if (response.total !== undefined) {
    state.expectedTotal = response.total;
  }

  const embeddingIndex = response.index ?? 0;

  if (response.chunkIndex !== undefined && response.totalChunks !== undefined) {
    if (!state.chunksByEmbedding.has(embeddingIndex)) {
      state.chunksByEmbedding.set(embeddingIndex, new Map());
      state.expectedChunks.set(embeddingIndex, response.totalChunks);
      state.fullDimensions.set(embeddingIndex, response.dimensions);
    }

    const chunks = state.chunksByEmbedding.get(embeddingIndex)!;
    chunks.set(response.chunkIndex, response.embeddings[0]!);

    if (chunks.size === state.expectedChunks.get(embeddingIndex)) {
      const fullEmbedding: number[] = [];
      for (let i = 0; i < chunks.size; i++) {
        fullEmbedding.push(...chunks.get(i)!);
      }
      state.collectedEmbeddings[embeddingIndex] = fullEmbedding;
    }
  } else {
    if (response.index !== undefined && response.embeddings[0]) {
      state.collectedEmbeddings[response.index] = response.embeddings[0];
    } else {
      state.collectedEmbeddings.push(...response.embeddings);
    }
  }

  const allComplete = state.collectedEmbeddings.filter((e) => e !== undefined).length;
  const complete = state.expectedTotal > 0 && allComplete >= state.expectedTotal;

  return { complete, embeddings: state.collectedEmbeddings };
}

function createEmbeddingResponsePromise(
  ref: StateRef<NodeState>,
  requestId: string,
  textCount: number,
  targetPeerId: string,
  request: EmbeddingRequest
): Promise<EmbeddingResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Embedding request timeout'));
    }, 30000);

    const collectorState = createResponseCollectorState(textCount);

    const responseHandler = (response: EmbeddingResponse) => {
      const { complete, embeddings } = processEmbeddingResponse(collectorState, response);
      if (complete) {
        clearTimeout(timeout);
        resolve({
          type: 'embedding-response',
          requestId,
          embeddings,
          model: response.model,
          dimensions: response.dimensions,
        });
      }
    };

    subscribeToTopic(ref, `embedding-response:${requestId}`, (event) => {
      if (event.type === 'message') {
        const parsed = EmbeddingResponseSchema.safeParse(event.payload);
        if (parsed.success) {
          responseHandler(parsed.data);
        }
      }
    });

    subscribeToTopic(ref, `peer:${getId(ref)}`, (event) => {
      if (event.type === 'message') {
        const parsed = EmbeddingResponseSchema.safeParse(event.payload);
        if (parsed.success && parsed.data.requestId === requestId) {
          responseHandler(parsed.data);
        }
      }
    });

    const messageEvent: MessageEvent = {
      type: 'message',
      from: getId(ref),
      to: targetPeerId,
      payload: request,
      timestamp: Date.now(),
    };
    publish(ref, `peer:${targetPeerId}`, messageEvent);
  });
}

export async function requestEmbeddings(
  ref: StateRef<NodeState>,
  texts: string[],
  config: { requireExchange?: boolean; model?: string; preferredPeers?: string[] } = {}
): Promise<number[][]> {
  const query: CapabilityQuery = {
    requiredCapabilities: [{ type: 'embedding' }],
    preferredPeers: config.preferredPeers,
  };

  const matches = await findPeers(ref, query);

  if (matches.length === 0 && config.preferredPeers && config.preferredPeers.length > 0) {
    const targetPeerId = config.preferredPeers[0]!;
    const requestId = `embedding-${Date.now()}-${randomUUID()}`;
    const request: EmbeddingRequest = {
      type: 'embedding-request',
      requestId,
      texts,
      model: config.model,
    };

    const response = await createEmbeddingResponsePromise(
      ref,
      requestId,
      texts.length,
      targetPeerId,
      request
    );

    const state = getState(ref);
    const existing = state.peers[targetPeerId];
    const newPeers = { ...state.peers };
    if (existing) {
      newPeers[targetPeerId] = {
        ...existing,
        servicesConsumed: (existing.servicesConsumed || 0) + 1,
        lastSeen: Date.now(),
      };
    } else {
      newPeers[targetPeerId] = {
        id: targetPeerId,
        addresses: [],
        capabilities: [],
        lastSeen: Date.now(),
        servicesConsumed: 1,
      };
    }
    setState(ref, { ...state, peers: newPeers });

    return response.embeddings;
  }

  if (matches.length === 0) {
    throw new Error('No embedding-capable peers found');
  }

  const selectedPeer = selectEmbeddingPeer(
    matches.map((m) => m.peer),
    config.requireExchange || false
  );

  if (!selectedPeer) {
    throw new Error('No eligible embedding peers (check service exchange balance)');
  }

  const requestId = `embedding-${Date.now()}-${randomUUID()}`;
  const request: EmbeddingRequest = {
    type: 'embedding-request',
    requestId,
    texts,
    model: config.model,
  };

  const response = await createEmbeddingResponsePromise(
    ref,
    requestId,
    texts.length,
    selectedPeer.id,
    request
  );

  const state = getState(ref);
  const peer = state.peers[selectedPeer.id];
  if (peer) {
    setState(ref, {
      ...state,
      peers: {
        ...state.peers,
        [selectedPeer.id]: {
          ...peer,
          servicesConsumed: (peer.servicesConsumed || 0) + 1,
        },
      },
    });
  }

  return response.embeddings;
}

export function updatePeerServiceProvided(ref: StateRef<NodeState>, peerId: string): void {
  const peers = getPeers(ref);
  const peer = peers.find((p) => p.id === peerId);
  if (!peer) {
    return;
  }
  const state = getState(ref);
  setState(ref, {
    ...state,
    peers: {
      ...state.peers,
      [peerId]: {
        ...peer,
        servicesProvided: (peer.servicesProvided || 0) + 1,
      },
    },
  });
}
