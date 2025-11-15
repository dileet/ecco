import type { AgentLoadState } from './types';

export namespace LoadBalancing {
  function createDefaultState(peerId: string): AgentLoadState {
    return {
      peerId,
      activeRequests: 0,
      totalRequests: 0,
      totalErrors: 0,
      averageLatency: 0,
      lastRequestTime: 0,
      successRate: 1.0,
    };
  }

  export function getLoadState(
    loadStates: Map<string, AgentLoadState>,
    peerId: string
  ): AgentLoadState {
    if (!loadStates.has(peerId)) {
      return createDefaultState(peerId);
    }
    return loadStates.get(peerId)!;
  }

  export function incrementActiveRequests(
    loadStates: Map<string, AgentLoadState>,
    peerId: string
  ): Map<string, AgentLoadState> {
    const current = getLoadState(loadStates, peerId);
    const updated: AgentLoadState = {
      ...current,
      activeRequests: current.activeRequests + 1,
      totalRequests: current.totalRequests + 1,
      lastRequestTime: Date.now(),
    };
    return new Map(loadStates).set(peerId, updated);
  }

  export function decrementActiveRequests(
    loadStates: Map<string, AgentLoadState>,
    peerId: string
  ): Map<string, AgentLoadState> {
    const current = getLoadState(loadStates, peerId);
    const updated: AgentLoadState = {
      ...current,
      activeRequests: Math.max(0, current.activeRequests - 1),
    };
    return new Map(loadStates).set(peerId, updated);
  }

  export function updateLoadState(
    loadStates: Map<string, AgentLoadState>,
    peerId: string,
    latency: number,
    success: boolean
  ): Map<string, AgentLoadState> {
    const current = getLoadState(loadStates, peerId);

    const totalErrors = success ? current.totalErrors : current.totalErrors + 1;
    const averageLatency = current.averageLatency * 0.8 + latency * 0.2;
    const successRate = (current.totalRequests - totalErrors) / current.totalRequests;

    const updated: AgentLoadState = {
      ...current,
      totalErrors,
      averageLatency,
      successRate,
    };

    return new Map(loadStates).set(peerId, updated);
  }

  export function getLoadStatistics(
    loadStates: Map<string, AgentLoadState>
  ): Map<string, AgentLoadState> {
    return new Map(loadStates);
  }

  export function resetLoadStatistics(): Map<string, AgentLoadState> {
    return new Map();
  }

  export function getAllStates(
    loadStates: Map<string, AgentLoadState>
  ): Map<string, AgentLoadState> {
    return loadStates;
  }
}

