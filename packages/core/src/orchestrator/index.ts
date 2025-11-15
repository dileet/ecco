import { Effect } from 'effect';
import { nanoid } from 'nanoid';
import type { CapabilityQuery, Message, CapabilityMatch } from '../types';
import type { NodeState } from '../node/types';
import type {
  MultiAgentConfig,
  AgentResponse,
  AggregatedResult,
  MultiAgentRequestState,
  AgentLoadState,
} from './types';
import { selectAgents } from './selection';
import { aggregateResponses } from './aggregation';
import { LoadBalancing } from './load-balancing';
import { Node } from '../node';

export type OrchestratorState = {
  loadStates: Map<string, AgentLoadState>;
  requestStates: Map<string, MultiAgentRequestState>;
};

namespace OrchestrationLogic {
  export function validateAgentCount(
    foundAgents: number,
    minRequired: number
  ): { valid: boolean; error?: string } {
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
  }

  export function prepareAgentRequests(
    selectedAgents: CapabilityMatch[],
    requestId: string,
    payload: unknown,
    nodeId: string
  ): Array<{ match: CapabilityMatch; message: Message }> {
    return selectedAgents.map((match) => ({
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
  }

  export function updateLoadStatesForExecution(
    loadStates: Map<string, AgentLoadState>,
    selectedAgents: CapabilityMatch[]
  ): Map<string, AgentLoadState> {
    let newLoadStates = loadStates;
    selectedAgents.forEach((match) => {
      newLoadStates = LoadBalancing.incrementActiveRequests(newLoadStates, match.peer.id);
    });
    return newLoadStates;
  }

  export function finalizeLoadStates(
    loadStates: Map<string, AgentLoadState>,
    selectedAgents: CapabilityMatch[]
  ): Map<string, AgentLoadState> {
    let newLoadStates = loadStates;
    selectedAgents.forEach((match) => {
      newLoadStates = LoadBalancing.decrementActiveRequests(newLoadStates, match.peer.id);
    });
    return newLoadStates;
  }
}

namespace OrchestrationEffects {
  export async function sendAgentRequest(
    nodeState: NodeState,
    message: Message,
    timeout: number,
    resolver: { resolve: (data: unknown) => void; reject: (error: Error) => void }
  ): Promise<{
    result: { response: unknown; latency: number; success: boolean; error?: Error };
    nodeState: NodeState;
  }> {
    const sendTime = Date.now();

    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolver.reject(new Error('Request timeout'));
          resolve({
            result: { response: null, latency: Date.now() - sendTime, success: false, error: new Error('Request timeout') },
            nodeState,
          });
        }
      }, timeout);

      const originalResolve = resolver.resolve;
      const originalReject = resolver.reject;
      
      resolver.resolve = (data: unknown) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          originalResolve(data);
          resolve({
            result: { response: data, latency: Date.now() - sendTime, success: true },
            nodeState,
          });
        }
      };
      
      resolver.reject = (error: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          originalReject(error);
          resolve({
            result: { response: null, latency: Date.now() - sendTime, success: false, error },
            nodeState,
          });
        }
      };
      
      Node.sendMessage(nodeState, message.to, message).catch((error) => {
        resolver.reject(error as Error);
      });
    });
  }
}

export namespace Orchestrator {
  export function createState(): OrchestratorState {
    return {
      loadStates: new Map(),
      requestStates: new Map(),
    };
  }

  async function sendToAgent(
    nodeState: NodeState,
    state: OrchestratorState,
    match: CapabilityMatch,
    message: Message,
    config: MultiAgentConfig,
    resolver: { resolve: (data: unknown) => void; reject: (error: Error) => void }
  ): Promise<{ response: AgentResponse; state: OrchestratorState; nodeState: NodeState }> {
    const { result, nodeState: updatedNodeState } = await OrchestrationEffects.sendAgentRequest(
      nodeState,
      message,
      config.timeout || 30000,
      resolver
    );

    let newLoadStates = state.loadStates;
    if (config.loadBalancing?.enabled) {
      newLoadStates = LoadBalancing.updateLoadState(
        newLoadStates,
        match.peer.id,
        result.latency,
        result.success
      );
    }

    return {
      response: {
        peer: match.peer,
        matchScore: match.matchScore,
        response: result.response,
        timestamp: Date.now(),
        latency: result.latency,
        error: result.error,
        success: result.success,
      },
      state: { ...state, loadStates: newLoadStates },
      nodeState: updatedNodeState,
    };
  }

  export async function execute(
    nodeState: NodeState,
    state: OrchestratorState,
    query: CapabilityQuery,
    payload: unknown,
    config: MultiAgentConfig
  ): Promise<{ result: AggregatedResult; state: OrchestratorState; nodeState: NodeState }> {
    const startTime = Date.now();
    const requestId = nanoid();

    const { matches: allMatches, state: updatedNodeState } = await Node.findPeers(nodeState, query);
    let currentNodeState = updatedNodeState;

    const validation = OrchestrationLogic.validateAgentCount(
      allMatches.length,
      config.minAgents || 1
    );
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const selectedAgents = selectAgents(allMatches, config, state.loadStates);

    const requests = OrchestrationLogic.prepareAgentRequests(
      selectedAgents,
      requestId,
      payload,
      Node.getId(currentNodeState)
    );

    console.log(
      `Executing multi-agent request with ${selectedAgents.length} agents using ${config.selectionStrategy} selection and ${config.aggregationStrategy} aggregation`
    );

    let currentState = state;
    if (config.loadBalancing?.enabled) {
      const newLoadStates = OrchestrationLogic.updateLoadStatesForExecution(
        currentState.loadStates,
        selectedAgents
      );
      currentState = { ...currentState, loadStates: newLoadStates };
    }

    try {
      let stateWithSubscriptions = currentNodeState;
      const responsePromises = new Map<string, Promise<unknown>>();
      const responseResolvers = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
      
      for (const req of requests) {
        const promise = new Promise<unknown>((resolve, reject) => {
          responseResolvers.set(req.message.id, { resolve, reject });
        });
        responsePromises.set(req.message.id, promise);
        
        const handler = (data: unknown) => {
          const resolver = responseResolvers.get(req.message.id);
          if (resolver) {
            resolver.resolve(data);
          }
        };
        
        stateWithSubscriptions = Node.subscribeToTopic(
          stateWithSubscriptions,
          `response:${req.message.id}`,
          handler
        );
      }

      for (const req of requests) {
        Node.sendMessage(stateWithSubscriptions, req.message.to, req.message).catch((error) => {
          const resolver = responseResolvers.get(req.message.id);
          if (resolver) {
            resolver.reject(error as Error);
          }
        });
      }

      const agentPromises = requests.map(async (req) => {
        const timeout = config.timeout || 30000;
        const sendTime = Date.now();
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Request timeout')), timeout);
        });
        
        try {
          const response = await Promise.race([
            responsePromises.get(req.message.id)!,
            timeoutPromise
          ]);
          
          const latency = Date.now() - sendTime;
          
          let newLoadStates = currentState.loadStates;
          if (config.loadBalancing?.enabled) {
            newLoadStates = LoadBalancing.updateLoadState(
              newLoadStates,
              req.match.peer.id,
              latency,
              true
            );
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
            nodeState: stateWithSubscriptions,
          };
        } catch (error) {
          const latency = Date.now() - sendTime;
          
          let newLoadStates = currentState.loadStates;
          if (config.loadBalancing?.enabled) {
            newLoadStates = LoadBalancing.updateLoadState(
              newLoadStates,
              req.match.peer.id,
              latency,
              false
            );
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
            nodeState: stateWithSubscriptions,
          };
        }
      });

      const results = await Promise.all(agentPromises);
      const responses = results.map((r) => r.response);

      if (results.length > 0) {
        currentState = results[results.length - 1].state;
        currentNodeState = results[results.length - 1].nodeState;
      }

      const configWithState: MultiAgentConfig = {
        ...config,
        nodeState: currentNodeState,
      };

      const result = await Effect.runPromise(aggregateResponses(responses, configWithState));
      result.metrics.totalTime = Date.now() - startTime;

      return { result, state: currentState, nodeState: currentNodeState };
    } finally {
      if (config.loadBalancing?.enabled) {
        const newLoadStates = OrchestrationLogic.finalizeLoadStates(
          currentState.loadStates,
          selectedAgents
        );
        currentState = { ...currentState, loadStates: newLoadStates };
      }
    }
  }

  export function getLoadStatistics(state: OrchestratorState): Map<string, AgentLoadState> {
    return LoadBalancing.getLoadStatistics(state.loadStates);
  }

  export function resetLoadStatistics(state: OrchestratorState): OrchestratorState {
    return {
      ...state,
      loadStates: LoadBalancing.resetLoadStatistics(),
    };
  }
}

export * from './types';
