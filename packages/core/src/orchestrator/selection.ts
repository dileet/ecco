import type { CapabilityMatch } from '../types';
import type { MultiAgentConfig, AgentLoadState } from './types';
import { LoadBalancing } from './load-balancing';

type SelectionStrategyFn = (matches: CapabilityMatch[]) => CapabilityMatch[];

export namespace SelectionStrategy {
  export const all: SelectionStrategyFn = (matches) => matches;

  export const topN = (n: number): SelectionStrategyFn =>
    (matches) => matches.slice(0, n);

  export const roundRobin = (
    loadStates: Map<string, AgentLoadState>,
    n: number
  ): SelectionStrategyFn => (matches) => {
    const sorted = [...matches].sort((a, b) => {
      const loadA = LoadBalancing.getLoadState(loadStates, a.peer.id);
      const loadB = LoadBalancing.getLoadState(loadStates, b.peer.id);
      return loadA.totalRequests - loadB.totalRequests;
    });
    return sorted.slice(0, n);
  };

  export const random = (n: number): SelectionStrategyFn => (matches) => {
    const shuffled = [...matches].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  };

  export const weighted = (
    loadStates: Map<string, AgentLoadState>,
    n: number,
    loadBalancingEnabled: boolean,
    loadWeight: number
  ): SelectionStrategyFn => (matches) => {
    const selected: CapabilityMatch[] = [];
    const available = [...matches];

    for (let i = 0; i < n && available.length > 0; i++) {
      const weights = available.map((match) => {
        const loadState = LoadBalancing.getLoadState(loadStates, match.peer.id);
        const loadFactor = loadBalancingEnabled
          ? 1 / (loadState.activeRequests + 1)
          : 1;

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
  };
}

export function selectAgents(
  matches: CapabilityMatch[],
  config: MultiAgentConfig,
  loadStates: Map<string, AgentLoadState>
): CapabilityMatch[] {
  const n = config.agentCount || 3;
  const strategy = config.selectionStrategy;

  switch (strategy) {
    case 'all':
      return SelectionStrategy.all(matches);

    case 'top-n':
      return SelectionStrategy.topN(n)(matches);

    case 'round-robin':
      return SelectionStrategy.roundRobin(loadStates, n)(matches);

    case 'random':
      return SelectionStrategy.random(n)(matches);

    case 'weighted':
      return SelectionStrategy.weighted(
        loadStates,
        n,
        config.loadBalancing?.enabled || false,
        config.loadBalancing?.loadWeight || 0.3
      )(matches);

    default:
      return SelectionStrategy.topN(n)(matches);
  }
}
