import type { CapabilityQuery, Message, CapabilityMatch } from '../types';
import type { NodeState, StateRef } from '../networking/types';
import {
  type MultiAgentConfig,
  type AgentResponse,
  type AggregatedResult,
  type AgentLoadState,
  type OrchestratorState,
  initialOrchestratorState,
  isOrchestratorStateRef,
} from './types';
import { aggregateResponses } from './aggregation';
import { findPeers, getId, getLibp2pPeerId, sendMessage, getState, updateState } from '../networking';
import { modifyState } from '../networking/state';
import { subscribeToAllDirectMessages, type MessageBridgeState } from '../networking/message-bridge';
import { writeExpectedInvoice } from '../storage';
import { selectAgents, defaultLoadState } from './selection';
import { createResponseHandler, type ResponseHandler } from './response-handler';
import { updateLoadStatesForExecution, finalizeLoadStates, applyLoadUpdates, type LoadUpdate } from './load-state';

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

const setupMessageBridge = (
  nodeRef: StateRef<NodeState>,
  nodeState: NodeState,
  handler: (message: Message) => void
): MessageBridgeState | undefined => {
  if (!nodeState.messageBridge) return undefined;
  const updatedBridge = subscribeToAllDirectMessages(nodeState.messageBridge, handler);
  updateState(nodeRef, (s) => ({ ...s, messageBridge: updatedBridge }));
  return updatedBridge;
};

const cleanupMessageBridge = (
  nodeRef: StateRef<NodeState>,
  bridge: MessageBridgeState | undefined,
  handler: (message: Message) => void
) => {
  if (!bridge) return;
  const latestNodeState = getState(nodeRef);
  if (latestNodeState.messageBridge) {
    const handlers = latestNodeState.messageBridge.directHandlers.get('*');
    handlers?.delete(handler);
  }
};

const sendRequests = async (
  nodeRef: StateRef<NodeState>,
  requests: Array<{ match: CapabilityMatch; message: Message }>,
  responseHandler: ResponseHandler
): Promise<void> => {
  const invoiceExpiresAt = Date.now() + 300000;
  await Promise.allSettled(
    requests.map(async (req) => {
      writeExpectedInvoice(req.message.id, req.message.to, invoiceExpiresAt).catch(() => {});
      try {
        await sendMessage(nodeRef, req.message.to, req.message);
      } catch (error) {
        responseHandler.rejectRequest(
          req.message.id,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    })
  );
};

const collectResponses = async (
  requests: Array<{ match: CapabilityMatch; message: Message }>,
  responseHandler: ResponseHandler
): Promise<{ responses: AgentResponse[]; loadUpdates: LoadUpdate[] }> => {
  const results = await Promise.all(
    requests.map(async (req): Promise<{ response: AgentResponse; loadUpdate: LoadUpdate }> => {
      const sendTime = Date.now();
      try {
        const response = await responseHandler.getPromise(req.message.id);
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
          loadUpdate: { peerId: req.match.peer.id, latency, success: true },
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
            error: error instanceof Error ? error : new Error(String(error)),
            success: false,
          },
          loadUpdate: { peerId: req.match.peer.id, latency, success: false },
        };
      }
    })
  );

  return {
    responses: results.map((r) => r.response),
    loadUpdates: results.map((r) => r.loadUpdate),
  };
};

export const executeOrchestration = async (
  nodeRef: StateRef<NodeState>,
  state: OrchestratorState | StateRef<OrchestratorState>,
  query: CapabilityQuery,
  payload: unknown,
  config: MultiAgentConfig,
  additionalResponses: AgentResponse[] = []
): Promise<{ result: AggregatedResult; state: OrchestratorState }> => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();

  const useRef = isOrchestratorStateRef(state);
  const stateRef = useRef ? state : null;
  let currentState: OrchestratorState = useRef ? state.current : state;
  const loadBalancingEnabled = config.loadBalancing?.enabled ?? false;

  const applyUpdate = (updater: (s: OrchestratorState) => OrchestratorState) => {
    if (stateRef) {
      modifyState(stateRef, (current): readonly [OrchestratorState, OrchestratorState] => {
        const updated = updater(current);
        return [updated, updated];
      });
      currentState = stateRef.current;
    } else {
      currentState = updater(currentState);
    }
  };

  const allMatches = await findPeers(nodeRef, query);
  const senderId = getLibp2pPeerId(nodeRef) ?? getId(nodeRef);
  const matchesExcludingSelf = allMatches.filter((m) => m.peer.id !== senderId);

  const totalAgentCount = matchesExcludingSelf.length + additionalResponses.length;
  if (totalAgentCount === 0) throw new Error('No matching agents found');
  if (totalAgentCount < (config.minAgents || 1)) {
    throw new Error(`Insufficient agents: found ${totalAgentCount}, required ${config.minAgents || 1}`);
  }

  const nodeState = getState(nodeRef);

  let selectedAgents: CapabilityMatch[];
  if (stateRef && loadBalancingEnabled) {
    selectedAgents = modifyState(
      stateRef,
      (current): readonly [CapabilityMatch[], OrchestratorState] => {
        const selected = selectAgents(matchesExcludingSelf, config, current.loadStates, nodeState);
        return [selected, { ...current, loadStates: updateLoadStatesForExecution(current.loadStates, selected) }];
      }
    );
    currentState = stateRef.current;
  } else {
    selectedAgents = selectAgents(matchesExcludingSelf, config, currentState.loadStates, nodeState);
    if (loadBalancingEnabled) {
      applyUpdate((s) => ({ ...s, loadStates: updateLoadStatesForExecution(s.loadStates, selectedAgents) }));
    }
  }

  const requests = prepareAgentRequests(selectedAgents, requestId, payload, senderId);
  const responseHandler = createResponseHandler({
    timeout: config.timeout ?? 120000,
    maxStreamBufferBytes: config.maxStreamBufferBytes,
    maxStreamChunks: config.maxStreamChunks,
    onStream: config.onStream,
  });

  for (const req of requests) {
    responseHandler.addPendingRequest(req.message.id);
  }

  const messageHandler = responseHandler.handleMessage;
  const updatedBridge = setupMessageBridge(nodeRef, nodeState, messageHandler);

  try {
    await sendRequests(nodeRef, requests, responseHandler);
    const { responses: peerResponses, loadUpdates } = await collectResponses(requests, responseHandler);
    const allResponses = [...additionalResponses, ...peerResponses];

    if (loadBalancingEnabled) {
      applyUpdate((s) => ({ ...s, loadStates: applyLoadUpdates(s.loadStates, loadUpdates) }));
    }

    const result = await aggregateResponses(allResponses, { ...config, nodeRef });
    result.metrics.totalTime = Date.now() - startTime;

    if (loadBalancingEnabled) {
      applyUpdate((s) => ({ ...s, loadStates: finalizeLoadStates(s.loadStates, selectedAgents) }));
    }

    return { result, state: currentState };
  } finally {
    if (loadBalancingEnabled) {
      applyUpdate((s) => ({ ...s, loadStates: finalizeLoadStates(s.loadStates, selectedAgents) }));
    }
    responseHandler.cleanup();
    cleanupMessageBridge(nodeRef, updatedBridge, messageHandler);
  }
};

export const getLoadStatistics = (state: OrchestratorState): Record<string, AgentLoadState> =>
  ({ ...state.loadStates });

export const resetLoadStatistics = (state: OrchestratorState): OrchestratorState => ({
  ...state,
  loadStates: {},
});

export { selectAgents, defaultLoadState } from './selection';
export { initialOrchestratorState, type OrchestratorState } from './types';
export * from './types';
