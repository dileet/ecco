import type { CapabilityMatch } from '../types';
import type { AgentLoadState } from './types';
import { defaultLoadState } from './selection';

const MAX_TOTAL_REQUESTS = 1_000_000;

export type LoadUpdate = {
  peerId: string;
  latency: number;
  success: boolean;
};

export const updateLoadStatesForExecution = (
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

export const finalizeLoadStates = (
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

export const applyLoadUpdates = (
  loadStates: Record<string, AgentLoadState>,
  updates: LoadUpdate[]
): Record<string, AgentLoadState> => {
  let result = loadStates;
  for (const update of updates) {
    const current = result[update.peerId] ?? defaultLoadState(update.peerId);
    const totalRequests = current.totalRequests;
    const nextErrors = current.totalErrors + (update.success ? 0 : 1);
    const totalErrors = Math.min(nextErrors, totalRequests);
    const successRate = totalRequests > 0 ? (totalRequests - totalErrors) / totalRequests : 1;

    result = {
      ...result,
      [update.peerId]: {
        ...current,
        totalErrors,
        averageLatency: current.averageLatency * 0.8 + update.latency * 0.2,
        successRate,
      },
    };
  }
  return result;
};
