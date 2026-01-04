import type { CapabilityQuery, Message, CapabilityMatch } from '../types';
import type { NodeState, StateRef } from '../node/types';
import type {
  MultiAgentConfig,
  AgentResponse,
  AggregatedResult,
  AgentLoadState,
} from './types';
import { aggregateResponses } from './aggregation';
import { findPeers, getId, getLibp2pPeerId, sendMessage, getState, updateState } from '../node';
import {
  subscribeToAllDirectMessages,
  type MessageBridgeState,
} from '../transport/message-bridge';
import { z } from 'zod';
import type { LatencyZone } from '../node/latency-zones';
import { selectByZoneWithFallback, sortByZone } from '../node/latency-zones';
import { secureRandom } from '../utils';
import { writeExpectedInvoice } from '../storage';

const MAX_FANOUT = 33;
const MAX_STREAM_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_STREAM_CHUNKS = 4096;

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

const getByteLength = (value: string): number => Buffer.byteLength(value);

export type OrchestratorState = {
  loadStates: Record<string, AgentLoadState>;
};

export const initialOrchestratorState: OrchestratorState = {
  loadStates: {},
};

const defaultLoadState = (peerId: string): AgentLoadState => ({
  peerId,
  activeRequests: 0,
  totalRequests: 0,
  totalErrors: 0,
  averageLatency: 0,
  lastRequestTime: 0,
  successRate: 1.0,
});

const selectAgents = (
  matches: CapabilityMatch[],
  config: MultiAgentConfig,
  loadStates: Record<string, AgentLoadState>,
  nodeState?: NodeState
): CapabilityMatch[] => {
  const n = config.agentCount || 3;
  let candidates = matches;

  if (config.stakeRequirement?.requireStake && nodeState?.reputationState) {
    const minStake = config.stakeRequirement.minStake ?? 0n;
    candidates = candidates.filter((match) => {
      const rep = nodeState.reputationState?.peers.get(match.peer.id);
      if (!rep) return false;
      return rep.canWork && rep.stake >= minStake;
    });
  }

  if (config.stakeRequirement?.preferStaked && nodeState?.reputationState) {
    const stakedBonus = config.stakeRequirement.stakedBonus ?? 0.2;
    candidates = candidates.map((match) => {
      const rep = nodeState.reputationState?.peers.get(match.peer.id);
      if (rep?.canWork) {
        return {
          ...match,
          matchScore: match.matchScore + stakedBonus,
        };
      }
      return match;
    });
    candidates.sort((a, b) => b.matchScore - a.matchScore);
  }

  const ignoreLatency = config.zoneSelection?.ignoreLatency ?? false;
  const preferredZone = config.zoneSelection?.preferredZone as LatencyZone | undefined;
  const maxZone = config.zoneSelection?.maxZone as LatencyZone | undefined;

  if (!ignoreLatency && nodeState?.latencyZones) {
    const zoneFiltered = selectByZoneWithFallback(
      candidates.map((m) => ({ peerId: m.peer.id, match: m })),
      nodeState.latencyZones,
      { preferredZone, maxZone, ignoreLatency },
      n
    );

    if (zoneFiltered.length > 0) {
      candidates = zoneFiltered.map((z) => z.match);
    } else if (preferredZone) {
      const sorted = sortByZone(
        candidates.map((m) => ({ peerId: m.peer.id, match: m })),
        nodeState.latencyZones,
        preferredZone
      );
      candidates = sorted.map((s) => s.match);
    }
  }

  switch (config.selectionStrategy) {
    case 'all':
      return candidates.slice(0, MAX_FANOUT);

    case 'top-n':
      return candidates.slice(0, n);

    case 'round-robin': {
      const sorted = [...candidates].sort((a, b) => {
        const loadA = loadStates[a.peer.id]?.totalRequests ?? 0;
        const loadB = loadStates[b.peer.id]?.totalRequests ?? 0;
        return loadA - loadB;
      });
      return sorted.slice(0, n);
    }

    case 'random':
      return [...candidates].sort(() => secureRandom() - 0.5).slice(0, n);

    case 'weighted': {
      const loadWeight = config.loadBalancing?.loadWeight ?? 0.3;
      const loadBalancingEnabled = config.loadBalancing?.enabled ?? false;
      const selected: CapabilityMatch[] = [];
      const available = [...candidates];

      for (let i = 0; i < n && available.length > 0; i++) {
        const weights = available.map((match) => {
          const activeRequests = loadStates[match.peer.id]?.activeRequests ?? 0;
          const loadFactor = loadBalancingEnabled ? 1 / (activeRequests + 1) : 1;
          return match.matchScore * (1 - loadWeight) + loadFactor * loadWeight;
        });

        const totalWeight = weights.reduce((sum, w) => sum + w, 0);
        let random = secureRandom() * totalWeight;

        let selectedIndex = 0;
        for (let j = 0; j < weights.length; j++) {
          random -= weights[j];
          if (random <= 0) {
            selectedIndex = j;
            break;
          }
        }

        selected.push(available[selectedIndex]);
        available.splice(selectedIndex, 1);
      }

      return selected;
    }

    default:
      return candidates.slice(0, n);
  }
};

const validateAgentCount = (
  foundAgents: number,
  minRequired: number
): { valid: boolean; error?: string } => {
  if (foundAgents === 0) {
    return { valid: false, error: 'No matching agents found' };
  }
  if (foundAgents < minRequired) {
    return {
      valid: false,
      error: `Insufficient agents: found ${foundAgents}, required ${minRequired}`,
    };
  }
  return { valid: true };
};

const prepareAgentRequests = (
  selectedAgents: CapabilityMatch[],
  requestId: string,
  payload: unknown,
  nodeId: string
): Array<{ match: CapabilityMatch; message: Message }> =>
  selectedAgents.map((match) => ({
    match,
    message: {
      id: `${requestId}-${match.peer.id}`,
      from: nodeId,
      to: match.peer.id,
      type: 'agent-request',
      payload,
      timestamp: Date.now(),
    },
  }));

const updateLoadStatesForExecution = (
  loadStates: Record<string, AgentLoadState>,
  selectedAgents: CapabilityMatch[]
): Record<string, AgentLoadState> => {
  let result = { ...loadStates };
  for (const match of selectedAgents) {
    const current = result[match.peer.id] ?? defaultLoadState(match.peer.id);
    result = {
      ...result,
      [match.peer.id]: {
        ...current,
        activeRequests: current.activeRequests + 1,
        totalRequests: current.totalRequests + 1,
        lastRequestTime: Date.now(),
      },
    };
  }
  return result;
};

const finalizeLoadStates = (
  loadStates: Record<string, AgentLoadState>,
  selectedAgents: CapabilityMatch[]
): Record<string, AgentLoadState> => {
  let result = { ...loadStates };
  for (const match of selectedAgents) {
    const current = result[match.peer.id] ?? defaultLoadState(match.peer.id);
    result = {
      ...result,
      [match.peer.id]: {
        ...current,
        activeRequests: Math.max(0, current.activeRequests - 1),
      },
    };
  }
  return result;
};

export const executeOrchestration = async (
  nodeRef: StateRef<NodeState>,
  state: OrchestratorState,
  query: CapabilityQuery,
  payload: unknown,
  config: MultiAgentConfig,
  additionalResponses: AgentResponse[] = []
): Promise<{ result: AggregatedResult; state: OrchestratorState }> => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();

  const allMatches = await findPeers(nodeRef, query);

  const libp2pPeerId = getLibp2pPeerId(nodeRef);
  const senderId = libp2pPeerId ?? getId(nodeRef);

  const matchesExcludingSelf = allMatches.filter((m) => m.peer.id !== senderId);

  const totalAgentCount = matchesExcludingSelf.length + additionalResponses.length;
  const validation = validateAgentCount(totalAgentCount, config.minAgents || 1);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const nodeState = getState(nodeRef);
  const selectedAgents = selectAgents(matchesExcludingSelf, config, state.loadStates, nodeState);

  const requests = prepareAgentRequests(
    selectedAgents,
    requestId,
    payload,
    senderId
  );

  let currentState = state;
  if (config.loadBalancing?.enabled) {
    const newLoadStates = updateLoadStatesForExecution(currentState.loadStates, selectedAgents);
    currentState = { ...currentState, loadStates: newLoadStates };
  }

  const responsePromises = new Map<string, Promise<unknown>>();
  const responseResolvers = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (error: Error) => void }
  >();
  const timeoutIds = new Map<string, ReturnType<typeof setTimeout>>();

  type StreamBufferState = {
    text: string;
    bytes: number;
    chunks: number;
  };

  const streamBuffers = new Map<string, StreamBufferState>();

  const responseTimeout = config.timeout ?? 120000;
  const maxStreamBufferBytes = config.maxStreamBufferBytes ?? MAX_STREAM_BUFFER_BYTES;
  const maxStreamChunks = config.maxStreamChunks ?? MAX_STREAM_CHUNKS;

  for (const req of requests) {
    const promise = new Promise<unknown>((resolve, reject) => {
      responseResolvers.set(req.message.id, { resolve, reject });

      const timeoutId = setTimeout(() => {
        const resolver = responseResolvers.get(req.message.id);
        if (resolver) {
          resolver.reject(new Error(`Response timeout after ${responseTimeout}ms`));
          responseResolvers.delete(req.message.id);
          streamBuffers.delete(req.message.id);
          timeoutIds.delete(req.message.id);
        }
      }, responseTimeout);

      timeoutIds.set(req.message.id, timeoutId);
    });
    responsePromises.set(req.message.id, promise);
    streamBuffers.set(req.message.id, { text: '', bytes: 0, chunks: 0 });
  }

  const directMessageHandler = (message: Message) => {
    if (message.type === 'stream-chunk') {
      const parsed = StreamChunkPayloadSchema.safeParse(message.payload);
      if (parsed.success) {
        const buffer = streamBuffers.get(parsed.data.requestId);
        if (buffer) {
          const chunkBytes = getByteLength(parsed.data.chunk);
          const nextBytes = buffer.bytes + chunkBytes;
          const nextChunks = buffer.chunks + 1;
          if (nextBytes > maxStreamBufferBytes || nextChunks > maxStreamChunks) {
            const resolver = responseResolvers.get(parsed.data.requestId);
            if (resolver) {
              resolver.reject(new Error('Stream exceeded maximum size'));
              responseResolvers.delete(parsed.data.requestId);
            }
            const timeoutId = timeoutIds.get(parsed.data.requestId);
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutIds.delete(parsed.data.requestId);
            }
            streamBuffers.delete(parsed.data.requestId);
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
      }
    }

    if (message.type === 'stream-complete') {
      const parsed = StreamCompletePayloadSchema.safeParse(message.payload);
      if (parsed.success) {
        const resolver = responseResolvers.get(parsed.data.requestId);
        if (resolver) {
          const timeoutId = timeoutIds.get(parsed.data.requestId);
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutIds.delete(parsed.data.requestId);
          }
          const buffer = streamBuffers.get(parsed.data.requestId);
          const bufferedText = buffer ? buffer.text : parsed.data.text;
          const totalBytes = buffer ? buffer.bytes : getByteLength(parsed.data.text);
          const totalChunks = buffer ? buffer.chunks : 1;
          if (totalBytes > maxStreamBufferBytes || totalChunks > maxStreamChunks) {
            resolver.reject(new Error('Stream exceeded maximum size'));
          } else {
            resolver.resolve({ text: bufferedText });
          }
          responseResolvers.delete(parsed.data.requestId);
          streamBuffers.delete(parsed.data.requestId);
        }
      }
    }

    if (message.type === 'agent-response') {
      const responsePayload = message.payload as { requestId?: string; response?: unknown };
      const msgRequestId = responsePayload?.requestId ?? message.id;

      const resolver = responseResolvers.get(msgRequestId);
      if (resolver) {
        const timeoutId = timeoutIds.get(msgRequestId);
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutIds.delete(msgRequestId);
        }
        resolver.resolve(responsePayload?.response ?? message.payload);
        responseResolvers.delete(msgRequestId);
        streamBuffers.delete(msgRequestId);
      }
    }
  };

  let updatedBridge: MessageBridgeState | undefined;

  if (nodeState.messageBridge) {
    updatedBridge = subscribeToAllDirectMessages(nodeState.messageBridge, directMessageHandler);
    updateState(nodeRef, (s) => ({ ...s, messageBridge: updatedBridge }));
  }

  const cleanup = () => {
    for (const timeoutId of timeoutIds.values()) {
      clearTimeout(timeoutId);
    }
    timeoutIds.clear();
    streamBuffers.clear();
    responseResolvers.clear();
    responsePromises.clear();

    if (updatedBridge) {
      const latestNodeState = getState(nodeRef);
      if (latestNodeState.messageBridge) {
        const handlers = latestNodeState.messageBridge.directHandlers.get('*');
        if (handlers) {
          handlers.delete(directMessageHandler);
        }
      }
    }
  };

  try {
    const invoiceExpiresAt = Date.now() + 300000;
    for (const req of requests) {
      writeExpectedInvoice(req.message.id, req.message.to, invoiceExpiresAt).catch(() => {});
      sendMessage(nodeRef, req.message.to, req.message).catch((error) => {
        const resolver = responseResolvers.get(req.message.id);
        if (resolver) {
          resolver.reject(error as Error);
        }
      });
    }

    const agentPromises = requests.map(async (req): Promise<{
      response: AgentResponse;
      state: OrchestratorState;
    }> => {
      const sendTime = Date.now();

      try {
        const response = await responsePromises.get(req.message.id)!;

        const latency = Date.now() - sendTime;

        let newLoadStates = currentState.loadStates;
        if (config.loadBalancing?.enabled) {
          const current = newLoadStates[req.match.peer.id] ?? defaultLoadState(req.match.peer.id);
          newLoadStates = {
            ...newLoadStates,
            [req.match.peer.id]: {
              ...current,
              averageLatency: current.averageLatency * 0.8 + latency * 0.2,
              successRate: (current.totalRequests - current.totalErrors) / current.totalRequests,
            },
          };
        }

        return {
          response: {
            peer: req.match.peer,
            matchScore: req.match.matchScore,
            response,
            timestamp: Date.now(),
            latency,
            success: true,
          },
          state: { ...currentState, loadStates: newLoadStates },
        };
      } catch (error) {
        const latency = Date.now() - sendTime;

        let newLoadStates = currentState.loadStates;
        if (config.loadBalancing?.enabled) {
          const current = newLoadStates[req.match.peer.id] ?? defaultLoadState(req.match.peer.id);
          const totalErrors = current.totalErrors + 1;
          newLoadStates = {
            ...newLoadStates,
            [req.match.peer.id]: {
              ...current,
              totalErrors,
              averageLatency: current.averageLatency * 0.8 + latency * 0.2,
              successRate: (current.totalRequests - totalErrors) / current.totalRequests,
            },
          };
        }

        return {
          response: {
            peer: req.match.peer,
            matchScore: req.match.matchScore,
            response: null,
            timestamp: Date.now(),
            latency,
            error: error as Error,
            success: false,
          },
          state: { ...currentState, loadStates: newLoadStates },
        };
      }
    });

    const results = await Promise.all(agentPromises);
    const peerResponses = results.map((r) => r.response);
    const allResponses = [...additionalResponses, ...peerResponses];

    if (results.length > 0) {
      currentState = results[results.length - 1].state;
    }

    const configWithRef: MultiAgentConfig = {
      ...config,
      nodeRef,
    };

    const result = await aggregateResponses(allResponses, configWithRef);
    result.metrics.totalTime = Date.now() - startTime;

    return { result, state: currentState };
  } finally {
    cleanup();

    if (config.loadBalancing?.enabled) {
      const newLoadStates = finalizeLoadStates(currentState.loadStates, selectedAgents);
      currentState = { ...currentState, loadStates: newLoadStates };
    }
  }
};

export const getLoadStatistics = (state: OrchestratorState): Record<string, AgentLoadState> =>
  ({ ...state.loadStates });

export const resetLoadStatistics = (state: OrchestratorState): OrchestratorState => ({
  ...state,
  loadStates: {},
});

export * from './types';
