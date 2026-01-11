import type { PeerPerformanceState, PeerMetrics } from './peer-performance';
import { calculateRecentAverageLatency, getMetrics } from './peer-performance';

export type LatencyZone = 'local' | 'regional' | 'continental' | 'global';

export interface ZoneThresholds {
  local: number;
  regional: number;
  continental: number;
}

export interface LatencyZoneState {
  thresholds: ZoneThresholds;
  peerZones: Map<string, LatencyZone>;
  zoneStats: Map<LatencyZone, ZoneStat>;
}

export interface ZoneStat {
  peerCount: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  totalLatency: bigint;
}

export interface LatencyZoneConfig {
  thresholds?: Partial<ZoneThresholds>;
}

export interface ZoneSelectionConfig {
  preferredZone?: LatencyZone;
  maxZone?: LatencyZone;
  zoneFallbackTimeout?: number;
  ignoreLatency?: boolean;
}

const DEFAULT_THRESHOLDS: ZoneThresholds = {
  local: 50,
  regional: 150,
  continental: 300,
};

const ZONE_ORDER: LatencyZone[] = ['local', 'regional', 'continental', 'global'];

export function createLatencyZoneState(config?: LatencyZoneConfig): LatencyZoneState {
  return {
    thresholds: {
      local: config?.thresholds?.local ?? DEFAULT_THRESHOLDS.local,
      regional: config?.thresholds?.regional ?? DEFAULT_THRESHOLDS.regional,
      continental: config?.thresholds?.continental ?? DEFAULT_THRESHOLDS.continental,
    },
    peerZones: new Map(),
    zoneStats: new Map([
      ['local', { peerCount: 0, avgLatency: 0, minLatency: Infinity, maxLatency: 0, totalLatency: 0n }],
      ['regional', { peerCount: 0, avgLatency: 0, minLatency: Infinity, maxLatency: 0, totalLatency: 0n }],
      ['continental', { peerCount: 0, avgLatency: 0, minLatency: Infinity, maxLatency: 0, totalLatency: 0n }],
      ['global', { peerCount: 0, avgLatency: 0, minLatency: Infinity, maxLatency: 0, totalLatency: 0n }],
    ]),
  };
}

export function classifyLatency(
  state: LatencyZoneState,
  latencyMs: number
): LatencyZone {
  if (latencyMs < state.thresholds.local) {
    return 'local';
  }
  if (latencyMs < state.thresholds.regional) {
    return 'regional';
  }
  if (latencyMs < state.thresholds.continental) {
    return 'continental';
  }
  return 'global';
}

export function updatePeerZone(
  state: LatencyZoneState,
  peerId: string,
  latencyMs: number
): LatencyZoneState {
  const zone = classifyLatency(state, latencyMs);
  const oldZone = state.peerZones.get(peerId);

  const newPeerZones = new Map(state.peerZones);
  newPeerZones.set(peerId, zone);

  const newZoneStats = new Map(state.zoneStats);

  if (oldZone && oldZone !== zone) {
    const oldStat = newZoneStats.get(oldZone);
    if (oldStat && oldStat.peerCount > 0) {
      newZoneStats.set(oldZone, {
        ...oldStat,
        peerCount: oldStat.peerCount - 1,
      });
    }
  }

  if (oldZone !== zone) {
    const newStat = newZoneStats.get(zone) ?? {
      peerCount: 0,
      avgLatency: 0,
      minLatency: Infinity,
      maxLatency: 0,
      totalLatency: 0n,
    };
    const newTotalLatency = newStat.totalLatency + BigInt(Math.round(latencyMs * 1000));
    const newPeerCount = newStat.peerCount + 1;
    newZoneStats.set(zone, {
      peerCount: newPeerCount,
      avgLatency: Number(newTotalLatency / BigInt(newPeerCount)) / 1000,
      minLatency: Math.min(newStat.minLatency, latencyMs),
      maxLatency: Math.max(newStat.maxLatency, latencyMs),
      totalLatency: newTotalLatency,
    });
  }

  return {
    ...state,
    peerZones: newPeerZones,
    zoneStats: newZoneStats,
  };
}

export function getPeerZone(state: LatencyZoneState, peerId: string): LatencyZone | undefined {
  return state.peerZones.get(peerId);
}

export function getPeersInZone(state: LatencyZoneState, zone: LatencyZone): string[] {
  const peers: string[] = [];
  for (const [peerId, peerZone] of state.peerZones) {
    if (peerZone === zone) {
      peers.push(peerId);
    }
  }
  return peers;
}

export function getPeersUpToZone(state: LatencyZoneState, maxZone: LatencyZone): string[] {
  const maxIndex = ZONE_ORDER.indexOf(maxZone);
  const validZones = new Set(ZONE_ORDER.slice(0, maxIndex + 1));

  const peers: string[] = [];
  for (const [peerId, zone] of state.peerZones) {
    if (validZones.has(zone)) {
      peers.push(peerId);
    }
  }
  return peers;
}

export function getZoneStats(state: LatencyZoneState, zone: LatencyZone): ZoneStat | undefined {
  return state.zoneStats.get(zone);
}

export function getAllZoneStats(state: LatencyZoneState): Map<LatencyZone, ZoneStat> {
  return new Map(state.zoneStats);
}

export function syncFromPerformance(
  zoneState: LatencyZoneState,
  performanceState: PeerPerformanceState
): LatencyZoneState {
  let updatedState = zoneState;

  for (const [peerId, metrics] of performanceState.metrics) {
    const avgLatency = calculateRecentAverageLatency(metrics);
    if (avgLatency !== Infinity) {
      updatedState = updatePeerZone(updatedState, peerId, avgLatency);
    }
  }

  return updatedState;
}

export function filterByZone<T extends { peerId: string }>(
  items: T[],
  zoneState: LatencyZoneState,
  config: ZoneSelectionConfig
): T[] {
  if (config.ignoreLatency) {
    return items;
  }

  const maxZone = config.maxZone ?? 'global';
  const maxIndex = ZONE_ORDER.indexOf(maxZone);

  return items.filter((item) => {
    const zone = zoneState.peerZones.get(item.peerId);
    if (!zone) {
      return maxZone === 'global';
    }
    return ZONE_ORDER.indexOf(zone) <= maxIndex;
  });
}

export function sortByZone<T extends { peerId: string }>(
  items: T[],
  zoneState: LatencyZoneState,
  preferredZone?: LatencyZone
): T[] {
  const targetZoneIndex = preferredZone ? ZONE_ORDER.indexOf(preferredZone) : 0;

  return [...items].sort((a, b) => {
    const zoneA = zoneState.peerZones.get(a.peerId);
    const zoneB = zoneState.peerZones.get(b.peerId);

    const indexA = zoneA ? ZONE_ORDER.indexOf(zoneA) : ZONE_ORDER.length;
    const indexB = zoneB ? ZONE_ORDER.indexOf(zoneB) : ZONE_ORDER.length;

    const distA = Math.abs(indexA - targetZoneIndex);
    const distB = Math.abs(indexB - targetZoneIndex);

    return distA - distB;
  });
}

export function selectByZoneWithFallback<T extends { peerId: string }>(
  items: T[],
  zoneState: LatencyZoneState,
  config: ZoneSelectionConfig,
  minCount: number
): T[] {
  if (config.ignoreLatency) {
    return items;
  }

  const preferredZone = config.preferredZone ?? 'local';
  const maxZone = config.maxZone ?? 'global';

  const startIndex = ZONE_ORDER.indexOf(preferredZone);
  const maxIndex = ZONE_ORDER.indexOf(maxZone);

  const selected: T[] = [];

  for (let i = startIndex; i <= maxIndex && selected.length < minCount; i++) {
    const zone = ZONE_ORDER[i];
    const validPeers = items.filter((item) => {
      const peerZone = zoneState.peerZones.get(item.peerId);
      return peerZone === zone;
    });

    for (const peer of validPeers) {
      if (selected.length >= minCount) break;
      if (!selected.some((s) => s.peerId.toLowerCase() === peer.peerId.toLowerCase())) {
        selected.push(peer);
      }
    }
  }

  return selected;
}

export function estimateLatencyByZone(zone: LatencyZone, thresholds: ZoneThresholds): number {
  switch (zone) {
    case 'local':
      return thresholds.local / 2;
    case 'regional':
      return (thresholds.local + thresholds.regional) / 2;
    case 'continental':
      return (thresholds.regional + thresholds.continental) / 2;
    case 'global':
      return thresholds.continental * 1.5;
  }
}

export function getZoneWeight(zone: LatencyZone): number {
  switch (zone) {
    case 'local':
      return 1.0;
    case 'regional':
      return 0.8;
    case 'continental':
      return 0.6;
    case 'global':
      return 0.4;
  }
}

export function calculateZoneScore(
  baseScore: number,
  zone: LatencyZone,
  boostLocal: boolean = true
): number {
  const weight = getZoneWeight(zone);
  if (boostLocal && zone === 'local') {
    return baseScore * weight * 1.2;
  }
  return baseScore * weight;
}
