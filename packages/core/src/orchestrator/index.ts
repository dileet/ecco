import type { CapabilityQuery, Message, CapabilityMatch } from '../types';
import type { NodeState, StateRef } from '../node/types';
import type {
  MultiAgentConfig,
  AgentResponse,
  AggregatedResult,
  AgentLoadState,
} from './types';
import { aggregateResponses } from './aggregation';
import { findPeers, getId, getLibp2pPeerId, sendMessage, getState, updateState, subscribeToTopic } from '../node';
import { withTimeout } from '../utils';
import {
  subscribeToAllDirectMessages,
  type MessageBridgeState,
} from '../transport/message-bridge';
import type { EccoEvent } from '../events';

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
  loadStates: Record<string, AgentLoadState>
): CapabilityMatch[] => {
  const n = config.agentCount || 3;

  switch (config.selectionStrategy) {
    case 'all':
      return matches;

    case 'top-n':
      return matches.slice(0, n);

    case 'round-robin': {
      const sorted = [...matches].sort((a, b) => {
        const loadA = loadStates[a.peer.id]?.totalRequests ?? 0;
        const loadB = loadStates[b.peer.id]?.totalRequests ?? 0;
        return loadA - loadB;
      });
      return sorted.slice(0, n);
    }

    case 'random':
      return [...matches].sort(() => Math.random() - 0.5).slice(0, n);

    case 'weighted': {
      const loadWeight = config.loadBalancing?.loadWeight ?? 0.3;
      const loadBalancingEnabled = config.loadBalancing?.enabled ?? false;
      const selected: CapabilityMatch[] = [];
      const available = [...matches];

      for (let i = 0; i < n && available.length > 0; i++) {
        const weights = available.map((match) => {
          const activeRequests = loadStates[match.peer.id]?.activeRequests ?? 0;
          const loadFactor = loadBalancingEnabled ? 1 / (activeRequests + 1) : 1;
          return match.matchScore * (1 - loadWeight) + loadFactor * loadWeight;
        });

        const totalWeight = weights.reduce((sum, w) => sum + w, 0);
        let random = Math.random() * totalWeight;

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
      return matches.slice(0, n);
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
  config: MultiAgentConfig
): Promise<{ result: AggregatedResult; state: OrchestratorState }> => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();

  const allMatches = await findPeers(nodeRef, query);

  const validation = validateAgentCount(allMatches.length, config.minAgents || 1);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const selectedAgents = selectAgents(allMatches, config, state.loadStates);

  const libp2pPeerId = getLibp2pPeerId(nodeRef);
  const senderId = libp2pPeerId ?? getId(nodeRef);

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

  for (const req of requests) {
    const promise = new Promise<unknown>((resolve, reject) => {
      responseResolvers.set(req.message.id, { resolve, reject });
    });
    responsePromises.set(req.message.id, promise);
  }

  const directMessageHandler = (message: Message) => {
    if (message.type === 'agent-response') {
      const responsePayload = message.payload as { requestId?: string; response?: unknown };
      const msgRequestId = responsePayload?.requestId ?? message.id;
      
      const resolver = responseResolvers.get(msgRequestId);
      if (resolver) {
        resolver.resolve(responsePayload?.response ?? message.payload);
        responseResolvers.delete(msgRequestId);
      }
    }
  };

  const nodeState = getState(nodeRef);
  let updatedBridge: MessageBridgeState | undefined;
  
  if (nodeState.messageBridge) {
    updatedBridge = subscribeToAllDirectMessages(nodeState.messageBridge, directMessageHandler);
    updateState(nodeRef, (s) => ({ ...s, messageBridge: updatedBridge }));
  }

  const topicHandler = (event: EccoEvent) => {
    if (event.type === 'message' && event.payload) {
      const message = event.payload as Message;
      directMessageHandler(message);
    }
  };
  
  let unsubscribeTopic: (() => void) | undefined;
  if (libp2pPeerId) {
    unsubscribeTopic = subscribeToTopic(nodeRef, `peer:${libp2pPeerId}`, topicHandler);
  }

  const cleanup = () => {
    if (unsubscribeTopic) {
      unsubscribeTopic();
    }
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
    for (const req of requests) {
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
      const timeout = config.timeout || 30000;
      const sendTime = Date.now();

      try {
        const response = await withTimeout(
          responsePromises.get(req.message.id)!,
          timeout,
          'Request timeout'
        );

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
    const responses = results.map((r) => r.response);

    if (results.length > 0) {
      currentState = results[results.length - 1].state;
    }

    const configWithRef: MultiAgentConfig = {
      ...config,
      nodeRef,
    };

    const result = await aggregateResponses(responses, configWithRef);
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
