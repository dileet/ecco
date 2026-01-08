import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { NodeState, StateRef } from '../node/types';
import { subscribeToTopic, getId, publish, findPeers, getState, setState, getPeer, addPeer, updatePeer, registerCleanup } from '../node';
import type { CapabilityQuery, PeerInfo } from '../types';
import { MessageEventSchema, type MessageEvent, type EccoEvent } from '../events';
import { withTimeout } from '../utils';
import type { EmbedFn } from '../agent/types';

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
    const chunkData = response.embeddings[0];
    if (chunkData) {
      chunks.set(response.chunkIndex, chunkData);
    }

    const expectedCount = state.expectedChunks.get(embeddingIndex) ?? 0;
    if (chunks.size === expectedCount && expectedCount > 0) {
      let allPresent = true;
      for (let i = 0; i < expectedCount; i++) {
        if (!chunks.has(i)) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) {
        const fullEmbedding: number[] = [];
        for (let i = 0; i < expectedCount; i++) {
          fullEmbedding.push(...chunks.get(i)!);
        }
        state.collectedEmbeddings[embeddingIndex] = fullEmbedding;
      }
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

async function createEmbeddingResponsePromise(
  ref: StateRef<NodeState>,
  requestId: string,
  textCount: number,
  targetPeerId: string,
  request: EmbeddingRequest,
  timeoutMs: number
): Promise<EmbeddingResponse> {
  const cleanupFunctions: Array<() => void> = [];

  const collectorPromise = new Promise<EmbeddingResponse>((resolve) => {
    const collectorState = createResponseCollectorState(textCount);

    const handleResponseEvent = (event: EccoEvent): void => {
      const messageEvent = MessageEventSchema.safeParse(event);
      if (!messageEvent.success) {
        return;
      }

      const parsed = EmbeddingResponseSchema.safeParse(messageEvent.data.payload);
      if (!parsed.success) {
        return;
      }

      if (parsed.data.requestId !== requestId) {
        return;
      }

      const { complete, embeddings } = processEmbeddingResponse(collectorState, parsed.data);
      if (complete) {
        resolve({
          type: 'embedding-response',
          requestId,
          embeddings,
          model: parsed.data.model,
          dimensions: parsed.data.dimensions,
        });
      }
    };

    const unsubscribe = subscribeToTopic(ref, `peer:${getId(ref)}`, handleResponseEvent);
    cleanupFunctions.push(unsubscribe);

    const message = {
      id: requestId,
      from: getId(ref),
      to: targetPeerId,
      type: 'embedding-request' as const,
      payload: request,
      timestamp: Date.now(),
    };
    const messageEvent: MessageEvent = {
      type: 'message',
      from: getId(ref),
      to: targetPeerId,
      payload: message,
      timestamp: Date.now(),
    };
    publish(ref, `peer:${targetPeerId}`, messageEvent);
  });

  try {
    return await withTimeout(collectorPromise, timeoutMs, 'Embedding request timeout');
  } finally {
    for (const cleanup of cleanupFunctions) {
      cleanup();
    }
  }
}

export async function requestEmbeddings(
  ref: StateRef<NodeState>,
  texts: string[],
  config: { requireExchange?: boolean; model?: string; preferredPeers?: string[]; timeout?: number } = {}
): Promise<number[][]> {
  const timeoutMs = config.timeout ?? 30000;

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
      request,
      timeoutMs
    );

    const state = getState(ref);
    const existing = getPeer(state, targetPeerId);
    if (existing) {
      setState(ref, updatePeer(state, targetPeerId, {
        servicesConsumed: (existing.servicesConsumed || 0) + 1,
        lastSeen: Date.now(),
      }));
    } else {
      setState(ref, addPeer(state, {
        id: targetPeerId,
        addresses: [],
        capabilities: [],
        lastSeen: Date.now(),
        servicesConsumed: 1,
      }));
    }

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
    request,
    timeoutMs
  );

  const state = getState(ref);
  const peer = getPeer(state, selectedPeer.id);
  if (peer) {
    setState(ref, updatePeer(state, selectedPeer.id, {
      servicesConsumed: (peer.servicesConsumed || 0) + 1,
    }));
  }

  return response.embeddings;
}

export function updatePeerServiceProvided(ref: StateRef<NodeState>, peerId: string): void {
  const state = getState(ref);
  const peer = getPeer(state, peerId);
  if (!peer) {
    return;
  }
  setState(ref, updatePeer(state, peerId, {
    servicesProvided: (peer.servicesProvided || 0) + 1,
  }));
}

export interface EmbeddingProviderConfig {
  nodeRef: StateRef<NodeState>
  embedFn: EmbedFn
  modelId: string
  libp2pPeerId?: string
}

// Chunk size: 32 floats = ~350 bytes JSON (safe for Bun's ChaCha20)
const CHUNK_SIZE = 32

// Split embedding into chunks to avoid Bun ChaCha20 cipher size limits
const chunkArray = <T>(array: T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}

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
  const fullEmbedding: number[] = []
  for (const chunk of chunks) {
    fullEmbedding.push(...chunk)
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
  }
}

const processEmbeddingProviderRequest = async (
  config: EmbeddingProviderConfig,
  event: MessageEvent,
  texts: string[],
  requestId: string
): Promise<void> => {
  const { nodeRef, embedFn, modelId } = config

  const embeddings = await embedFn(texts)

  for (let i = 0; i < embeddings.length; i++) {
    const embedding = embeddings[i]!
    const chunks = chunkArray(embedding, CHUNK_SIZE)

    const responseEvent = createBatchedResponseEvent(
      nodeRef,
      event.from,
      requestId,
      chunks,
      i,
      texts.length,
      modelId,
      embedding.length
    )

    await publish(nodeRef, `peer:${event.from}`, responseEvent)
  }

  updatePeerServiceProvided(nodeRef, event.from)
}

export function setupEmbeddingProvider(config: EmbeddingProviderConfig): void {
  const { nodeRef, libp2pPeerId } = config

  const handleEmbeddingRequest = async (event: unknown): Promise<void> => {
    const messageEvent = MessageEventSchema.safeParse(event)
    if (!messageEvent.success) return

    const eventPayload = messageEvent.data.payload as { type?: string; payload?: unknown; from?: string }
    const requestPayload = eventPayload?.type === 'embedding-request' ? eventPayload.payload : eventPayload
    const eventFrom = eventPayload?.from ?? messageEvent.data.from

    const request = EmbeddingRequestSchema.safeParse(requestPayload)
    if (!request.success) return

    const effectiveEvent = { ...messageEvent.data, from: eventFrom }

    try {
      await processEmbeddingProviderRequest(config, effectiveEvent, request.data.texts, request.data.requestId)
    } catch (error) {
      console.error(`[${getId(nodeRef)}] Embedding error:`, error)
    }
  }

  const unsubscribe1 = subscribeToTopic(nodeRef, `peer:${getId(nodeRef)}`, handleEmbeddingRequest)
  registerCleanup(nodeRef, unsubscribe1)

  if (libp2pPeerId) {
    const unsubscribe2 = subscribeToTopic(nodeRef, `peer:${libp2pPeerId}`, handleEmbeddingRequest)
    registerCleanup(nodeRef, unsubscribe2)
  }
}
