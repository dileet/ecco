import type { CapabilityMatch } from '../types';
import type { NodeState } from '../networking/types';
import type { MultiAgentConfig, AgentLoadState } from './types';
import type { LatencyZone } from '../reputation/latency-zones';
import { selectByZoneWithFallback, sortByZone } from '../reputation/latency-zones';
import { secureRandom } from '../utils';

const MAX_FANOUT = 33;

export const defaultLoadState = (peerId: string): AgentLoadState => ({
  peerId,
  activeRequests: 0,
  totalRequests: 0,
  totalErrors: 0,
  averageLatency: 0,
  lastRequestTime: 0,
  successRate: 0.5,
});

const applyStakeFilter = (
  candidates: CapabilityMatch[],
  config: MultiAgentConfig,
  nodeState: NodeState | undefined
): CapabilityMatch[] => {
  if (!config.stakeRequirement?.requireStake) {
    return candidates;
  }

  if (!nodeState?.reputationState) {
    throw new Error('Stake requirement enabled but reputation state is not configured');
  }

  const minStake = config.stakeRequirement.minStake ?? 0n;
  return candidates.filter((match) => {
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
};

const applyStakeBonus = (
  candidates: CapabilityMatch[],
  config: MultiAgentConfig,
  nodeState: NodeState | undefined
): CapabilityMatch[] => {
  if (!config.stakeRequirement?.preferStaked || !nodeState?.reputationState) {
    return candidates;
  }

  const stakedBonus = config.stakeRequirement.stakedBonus ?? 0.2;
  const boosted = candidates.map((match) => {
    const rep = nodeState.reputationState?.peers.get(match.peer.id);
    if (rep?.canWork) {
      return { ...match, matchScore: match.matchScore + stakedBonus };
    }
    return match;
  });

  return boosted.sort((a, b) => b.matchScore - a.matchScore);
};

const applyZoneFilter = (
  candidates: CapabilityMatch[],
  config: MultiAgentConfig,
  nodeState: NodeState | undefined,
  count: number
): CapabilityMatch[] => {
  const ignoreLatency = config.zoneSelection?.ignoreLatency ?? false;
  const preferredZone = config.zoneSelection?.preferredZone as LatencyZone | undefined;
  const maxZone = config.zoneSelection?.maxZone as LatencyZone | undefined;

  if (ignoreLatency || !nodeState?.latencyZones) {
    return candidates;
  }

  const zoneFiltered = selectByZoneWithFallback(
    candidates.map((m) => ({ peerId: m.peer.id, match: m })),
    nodeState.latencyZones,
    { preferredZone, maxZone, ignoreLatency },
    count
  );

  if (zoneFiltered.length > 0) {
    return zoneFiltered.map((z) => z.match);
  }

  if (preferredZone) {
    const sorted = sortByZone(
      candidates.map((m) => ({ peerId: m.peer.id, match: m })),
      nodeState.latencyZones,
      preferredZone
    );
    return sorted.map((s) => s.match);
  }

  return candidates;
};

const selectByStrategy = (
  candidates: CapabilityMatch[],
  config: MultiAgentConfig,
  loadStates: Record<string, AgentLoadState>,
  count: number
): CapabilityMatch[] => {
  switch (config.selectionStrategy) {
    case 'all':
      return candidates.slice(0, MAX_FANOUT);

    case 'top-n':
      return candidates.slice(0, count);

    case 'round-robin': {
      const sorted = [...candidates].sort((a, b) => {
        const timeA = loadStates[a.peer.id]?.lastRequestTime ?? 0;
        const timeB = loadStates[b.peer.id]?.lastRequestTime ?? 0;
        return timeA - timeB;
      });
      return sorted.slice(0, count);
    }

    case 'random': {
      const shuffled = [...candidates];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(secureRandom() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled.slice(0, count);
    }

    case 'weighted': {
      const rawLoadWeight = config.loadBalancing?.loadWeight ?? 0.3;
      const loadWeight = Math.max(0, Math.min(1, rawLoadWeight));
      const loadBalancingEnabled = config.loadBalancing?.enabled ?? false;
      const selected: CapabilityMatch[] = [];
      const available = [...candidates];

      for (let i = 0; i < count && available.length > 0; i++) {
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
      return candidates.slice(0, count);
  }
};

export const selectAgents = (
  matches: CapabilityMatch[],
  config: MultiAgentConfig,
  loadStates: Record<string, AgentLoadState>,
  nodeState?: NodeState
): CapabilityMatch[] => {
  const count = config.agentCount ?? 3;

  let candidates = applyStakeFilter(matches, config, nodeState);
  candidates = applyStakeBonus(candidates, config, nodeState);
  candidates = applyZoneFilter(candidates, config, nodeState, count);

  return selectByStrategy(candidates, config, loadStates, count);
};
