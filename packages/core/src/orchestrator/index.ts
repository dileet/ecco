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
import { modifyState } from '../node/state';
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
const MAX_TOTAL_REQUESTS = 1_000_000;

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

type OrchestratorStateContainer = OrchestratorState | StateRef<OrchestratorState>;

const AgentLoadStateSchema = z.object({
  peerId: z.string(),
  activeRequests: z.number(),
  totalRequests: z.number(),
  totalErrors: z.number(),
  averageLatency: z.number(),
  lastRequestTime: z.number(),
  successRate: z.number(),
});

const OrchestratorStateSchema = z.object({
  loadStates: z.record(z.string(), AgentLoadStateSchema),
});

const OrchestratorStateRefSchema = z.object({
  current: OrchestratorStateSchema,
  version: z.number(),
});

const isOrchestratorStateRef = (
  value: OrchestratorStateContainer
): value is StateRef<OrchestratorState> =>
  OrchestratorStateRefSchema.safeParse(value).success;

const defaultLoadState = (peerId: string): AgentLoadState => ({
  peerId,
  activeRequests: 0,
  totalRequests: 0,
  totalErrors: 0,
  averageLatency: 0,
  lastRequestTime: 0,
  successRate: 0.5,
});

const selectAgents = (
  matches: CapabilityMatch[],
  config: MultiAgentConfig,
  loadStates: Record<string, AgentLoadState>,
  nodeState?: NodeState
): CapabilityMatch[] => {
  const n = config.agentCount ?? 3;
  let candidates = matches;

  if (config.stakeRequirement?.requireStake) {
    if (!nodeState?.reputationState) {
      throw new Error('Stake requirement enabled but reputation state is not configured');
    }
    const minStake = config.stakeRequirement.minStake ?? 0n;
    const beforeCount = candidates.length;
    candidates = candidates.filter((match) => {
      const rep = nodeState.reputationState?.peers.get(match.peer.id);
      if (!rep) {
        console.warn(`[orchestrator] Peer ${match.peer.id} excluded: no reputation data`);
        return false;
      }
      if (!rep.canWork || rep.stake < minStake) {
        console.warn(`[orchestrator] Peer ${match.peer.id} excluded: canWork=${rep.canWork}, stake=${rep.stake}, required=${minStake}`);
        return false;
      }
      return true;
    });
    if (beforeCount !== candidates.length) {
      console.warn(`[orchestrator] Stake filter excluded ${beforeCount - candidates.length} peers`);
    }
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
        const timeA = loadStates[a.peer.id]?.lastRequestTime ?? 0;
        const timeB = loadStates[b.peer.id]?.lastRequestTime ?? 0;
        return timeA - timeB;
      });
      return sorted.slice(0, n);
    }

    case 'random': {
      const shuffled = [...candidates];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(secureRandom() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled.slice(0, n);
    }

    case 'weighted': {
      const rawLoadWeight = config.loadBalancing?.loadWeight ?? 0.3;
      const loadWeight = Math.max(0, Math.min(1, rawLoadWeight));
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

        let selectedIndex = 0;
        if (totalWeight > 0) {
          let random = secureRandom() * totalWeight;
          for (let j = 0; j < weights.length; j++) {
            random -= weights[j];
            if (random <= 0) {
              selectedIndex = j;
              break;
            }
          }
        } else {
          selectedIndex = Math.floor(secureRandom() * available.length);
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
    const nextTotalRequests = current.totalRequests >= MAX_TOTAL_REQUESTS
      ? current.totalRequests
      : current.totalRequests + 1;
    result = {
      ...result,
      [match.peer.id]: {
        ...current,
        activeRequests: current.activeRequests + 1,
        totalRequests: nextTotalRequests,
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

type LoadUpdate = {
  peerId: string;
  latency: number;
  success: boolean;
};

const applyLoadUpdate = (
  loadStates: Record<string, AgentLoadState>,
  update: LoadUpdate
): Record<string, AgentLoadState> => {
  const current = loadStates[update.peerId] ?? defaultLoadState(update.peerId);
  const totalRequests = current.totalRequests;
  const nextErrors = current.totalErrors + (update.success ? 0 : 1);
  const totalErrors = Math.min(nextErrors, totalRequests);
  const successRate =
    totalRequests > 0 ? (totalRequests - totalErrors) / totalRequests : 1;
  return {
    ...loadStates,
    [update.peerId]: {
      ...current,
      totalErrors,
      averageLatency: current.averageLatency * 0.8 + update.latency * 0.2,
      successRate,
    },
  };
};

export const executeOrchestration = async (
  nodeRef: StateRef<NodeState>,
  state: OrchestratorStateContainer,
  query: CapabilityQuery,
  payload: unknown,
  config: MultiAgentConfig,
  additionalResponses: AgentResponse[] = []
): Promise<{ result: AggregatedResult; state: OrchestratorState }> => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();

  const stateRef = isOrchestratorStateRef(state) ? state : null;
  let currentState: OrchestratorState;
  if (stateRef) {
    currentState = stateRef.current;
  } else if (isOrchestratorStateRef(state)) {
    currentState = state.current;
  } else {
    currentState = state;
  }
  const loadBalancingEnabled = config.loadBalancing?.enabled ?? false;

  const applyStateUpdate = (
    updater: (current: OrchestratorState) => OrchestratorState
  ): OrchestratorState => {
    if (stateRef) {
      const nextState = modifyState(
        stateRef,
        (current): readonly [OrchestratorState, OrchestratorState] => {
          const updated = updater(current);
          return [updated, updated];
        }
      );
      currentState = stateRef.current;
      return nextState;
    }
    currentState = updater(currentState);
    return currentState;
  };

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
  let selectedAgents: CapabilityMatch[];
  let loadStatesUpdatedForExecution = false;

  if (stateRef && loadBalancingEnabled) {
    const selectAndUpdateLoadStates = (
      current: OrchestratorState
    ): readonly [CapabilityMatch[], OrchestratorState] => {
      const selected = selectAgents(matchesExcludingSelf, config, current.loadStates, nodeState);
      const nextState = {
        ...current,
        loadStates: updateLoadStatesForExecution(current.loadStates, selected),
      };
      return [selected, nextState];
    };

    selectedAgents = modifyState(stateRef, selectAndUpdateLoadStates);
    currentState = stateRef.current;
    loadStatesUpdatedForExecution = true;
  } else {
    currentState = stateRef ? stateRef.current : currentState;
    selectedAgents = selectAgents(matchesExcludingSelf, config, currentState.loadStates, nodeState);
  }

  const requests = prepareAgentRequests(
    selectedAgents,
    requestId,
    payload,
    senderId
  );

  let shouldFinalizeLoadStates = false;
  if (loadBalancingEnabled) {
    if (!loadStatesUpdatedForExecution) {
      applyStateUpdate((current) => ({
        ...current,
        loadStates: updateLoadStatesForExecution(current.loadStates, selectedAgents),
      }));
    }
    shouldFinalizeLoadStates = true;
  }

  const responsePromises = new Map<string, Promise<unknown>>();
  type ResponseResolver = {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
  };
  const responseResolvers = new Map<string, ResponseResolver>();
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
  const getError = (value: unknown): Error =>
    value instanceof Error ? value : new Error(String(value));
  const takeResolver = (requestId: string): ResponseResolver | undefined => {
    const resolver = responseResolvers.get(requestId);
    if (!resolver) {
      return undefined;
    }
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

  for (const req of requests) {
    const promise = new Promise<unknown>((resolve, reject) => {
      responseResolvers.set(req.message.id, { resolve, reject });

      const timeoutId = setTimeout(() => {
        const resolver = takeResolver(req.message.id);
        if (resolver) {
          resolver.reject(new Error(`Response timeout after ${responseTimeout}ms`));
          finalizeRequest(req.message.id);
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
      }
    }

    if (message.type === 'stream-complete') {
      const parsed = StreamCompletePayloadSchema.safeParse(message.payload);
      if (parsed.success) {
        const buffer = streamBuffers.get(parsed.data.requestId);
        const bufferedText = buffer ? buffer.text : parsed.data.text;
        const totalBytes = buffer ? buffer.bytes : getByteLength(parsed.data.text);
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
      }
    }

    if (message.type === 'agent-response') {
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
    }
  };

  let updatedBridge: MessageBridgeState | undefined;

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
    if (nodeState.messageBridge) {
      updatedBridge = subscribeToAllDirectMessages(nodeState.messageBridge, directMessageHandler);
      updateState(nodeRef, (s) => ({ ...s, messageBridge: updatedBridge }));
    }

    const invoiceExpiresAt = Date.now() + 300000;
    const sendPromises = requests.map(async (req) => {
      writeExpectedInvoice(req.message.id, req.message.to, invoiceExpiresAt).catch(() => {});
      try {
        await sendMessage(nodeRef, req.message.to, req.message);
      } catch (error) {
        const resolver = takeResolver(req.message.id);
        if (resolver) {
          finalizeRequest(req.message.id);
          resolver.reject(getError(error));
        }
      }
    });
    await Promise.allSettled(sendPromises);

    const agentPromises = requests.map(async (req): Promise<{
      response: AgentResponse;
      loadUpdate: LoadUpdate;
    }> => {
      const sendTime = Date.now();

      try {
        const response = await responsePromises.get(req.message.id);

        const latency = Date.now() - sendTime;

        return {
          response: {
            peer: req.match.peer,
            matchScore: req.match.matchScore,
            response,
            timestamp: Date.now(),
            latency,
            success: true,
          },
          loadUpdate: {
            peerId: req.match.peer.id,
            latency,
            success: true,
          },
        };
      } catch (error) {
        const latency = Date.now() - sendTime;

        return {
          response: {
            peer: req.match.peer,
            matchScore: req.match.matchScore,
            response: null,
            timestamp: Date.now(),
            latency,
            error: getError(error),
            success: false,
          },
          loadUpdate: {
            peerId: req.match.peer.id,
            latency,
            success: false,
          },
        };
      }
    });

    const results = await Promise.all(agentPromises);
    const peerResponses = results.map((r) => r.response);
    const allResponses = [...additionalResponses, ...peerResponses];

    if (loadBalancingEnabled) {
      applyStateUpdate((current) => ({
        ...current,
        loadStates: results.reduce(
          (loadStates, result) => applyLoadUpdate(loadStates, result.loadUpdate),
          current.loadStates
        ),
      }));
    }

    const configWithRef: MultiAgentConfig = {
      ...config,
      nodeRef,
    };

    const result = await aggregateResponses(allResponses, configWithRef);
    result.metrics.totalTime = Date.now() - startTime;

    if (loadBalancingEnabled) {
      applyStateUpdate((current) => ({
        ...current,
        loadStates: finalizeLoadStates(current.loadStates, selectedAgents),
      }));
      shouldFinalizeLoadStates = false;
    }

    return { result, state: currentState };
  } finally {
    if (loadBalancingEnabled && shouldFinalizeLoadStates) {
      applyStateUpdate((current) => ({
        ...current,
        loadStates: finalizeLoadStates(current.loadStates, selectedAgents),
      }));
    }
    cleanup();
  }
};

export const getLoadStatistics = (state: OrchestratorState): Record<string, AgentLoadState> =>
  ({ ...state.loadStates });

export const resetLoadStatistics = (state: OrchestratorState): OrchestratorState => ({
  ...state,
  loadStates: {},
});

export * from './types';
