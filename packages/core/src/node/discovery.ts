import type { PeerId } from '@libp2p/interface';
import type { NodeState, StateRef } from './types';
import type { CapabilityQuery, CapabilityMatch, PeerInfo } from '../types';
import { matchPeers } from '../orchestrator/capability-matcher';
import { announceCapabilities, setupCapabilityTracking, requestCapabilities, findMatchingPeers } from './capabilities';
import { setupPerformanceTracking } from './peer-performance';
import { getState, updateState, removePeer, addPeers, hasPeer, getAllPeers, setMessageBridge } from './state';
import { delay, debug } from '../utils';
import { queryCapabilities } from './dht';
import type { LRUCache } from '../utils/lru-cache';
import type { PriorityDiscoveryConfig, DiscoveryPriority } from '../agent/types';
import { getProximityPeers, getPeersByPhase, type DiscoveryResult } from '../transport/hybrid-discovery';
import { findCandidates, type FilterTier } from './bloom-filter';
import { getLocalReputation, getEffectiveScore } from './reputation';
import { getPeerZone, getZoneWeight, type LatencyZone } from './latency-zones';
import { initiateHandshake, isHandshakeRequired, removePeerValidation } from '../transport/message-bridge';


function extractPeerIdFromAddr(addr: string): string | null {
  const match = addr.match(/\/p2p\/([^/]+)$/);
  return match ? match[1] : null;
}

function getBootstrapPeerIds(config: NodeState['config']): Set<string> {
  const peerIds = new Set<string>();
  if (config.bootstrap?.peers) {
    for (const addr of config.bootstrap.peers) {
      const peerId = extractPeerIdFromAddr(addr);
      if (peerId) peerIds.add(peerId);
    }
  }
  return peerIds;
}

const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_DISCOVERED_PEERS = 1000;

function cleanupStaleEntries(discoveredPeers: Map<string, number>): void {
  const now = Date.now();
  for (const [peerId, timestamp] of discoveredPeers) {
    if (now - timestamp > DISCOVERY_CACHE_TTL_MS) {
      discoveredPeers.delete(peerId);
    }
  }
  if (discoveredPeers.size > MAX_DISCOVERED_PEERS) {
    const entries = Array.from(discoveredPeers.entries())
      .sort((a, b) => a[1] - b[1]);
    const toRemove = entries.slice(0, discoveredPeers.size - MAX_DISCOVERED_PEERS);
    for (const [peerId] of toRemove) {
      discoveredPeers.delete(peerId);
    }
  }
}

export function setupEventListeners(
  state: NodeState,
  stateRef: StateRef<NodeState>
): void {
  if (!state.node) {
    return;
  }

  const node = state.node;
  const discoveredPeers = new Map<string, number>();
  const bootstrapPeerIds = getBootstrapPeerIds(state.config);

  node.addEventListener('peer:discovery', async (evt: CustomEvent<{ id: PeerId; multiaddrs: unknown[] }>) => {
    const { id: peerId } = evt.detail;
    const peerIdStr = peerId.toString();

    cleanupStaleEntries(discoveredPeers);

    if (discoveredPeers.has(peerIdStr)) {
      return;
    }

    discoveredPeers.set(peerIdStr, Date.now());

    if (bootstrapPeerIds.has(peerIdStr)) {
      return;
    }

    try {
      await node.dial(peerId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (!errorMessage.includes('ECONNREFUSED') && !errorMessage.includes('timeout')) {
        console.warn(`[${state.id}] Failed to dial peer: ${peerIdStr}`, errorMessage);
      }
    }
  });

  node.addEventListener('peer:connect', (evt: CustomEvent<PeerId>) => {
    const peerId = evt.detail.toString();
    const currentState = getState(stateRef);
    if (!hasPeer(currentState, peerId)) {
      const peerAddresses = node.getConnections()
        .filter(conn => conn.remotePeer.toString().toLowerCase() === peerId.toLowerCase())
        .flatMap(conn => conn.remoteAddr ? [conn.remoteAddr.toString()] : []);

      updateState(stateRef, (s) => addPeers(s, [{
        id: peerId,
        addresses: peerAddresses,
        capabilities: [],
        lastSeen: Date.now(),
      }]));
    }

    if (currentState.messageBridge && isHandshakeRequired(currentState.messageBridge)) {
      debug('discovery', `Initiating handshake with peer ${peerId}`);
      initiateHandshake(currentState.messageBridge, peerId)
        .then((updatedBridge) => {
          updateState(stateRef, (s) => setMessageBridge(s, updatedBridge));
        })
        .catch(() => {});
    }

    handlePeerConnect(stateRef).catch(() => {});
  });

  node.addEventListener('peer:disconnect', (evt: CustomEvent<PeerId>) => {
    const peerId = evt.detail.toString();
    discoveredPeers.delete(peerId);
    const currentState = getState(stateRef);
    if (currentState.messageBridge) {
      const updatedBridge = removePeerValidation(currentState.messageBridge, peerId);
      updateState(stateRef, (s) => ({ ...removePeer(s, peerId), messageBridge: updatedBridge }));
    } else {
      updateState(stateRef, (s) => removePeer(s, peerId));
    }
  });
}

async function handlePeerConnect(stateRef: StateRef<NodeState>): Promise<void> {
  setupCapabilityTracking(stateRef);
  updateState(stateRef, setupPerformanceTracking);
  const state = getState(stateRef);
  await announceCapabilities(state);
}

type DiscoveryStrategy = 'local' | 'dht' | 'gossip';

function selectDiscoveryStrategy(
  localMatches: CapabilityMatch[],
  config: NodeState['config'],
  hasDHT: boolean
): DiscoveryStrategy[] {
  if (localMatches.length > 0) {
    return ['local'];
  }

  const strategies: DiscoveryStrategy[] = [];

  if (config.discovery.includes('dht') && hasDHT) {
    strategies.push('dht');
  }

  if (config.discovery.includes('gossip')) {
    strategies.push('gossip');
  }

  return strategies;
}

function mergePeers(
  existingPeers: LRUCache<string, PeerInfo>,
  newPeers: PeerInfo[]
): PeerInfo[] {
  return newPeers.filter(peer => !existingPeers.has(peer.id));
}

interface PeerScoringFactors {
  bloomTier: FilterTier | null;
  reputationScore: number;
  latencyZone: LatencyZone | null;
  matchScore: number;
}

function calculateCombinedScore(factors: PeerScoringFactors): number {
  const tierBonus: Record<FilterTier, number> = { elite: 0.3, good: 0.15, acceptable: 0.05 };
  const bloomBonus = factors.bloomTier ? tierBonus[factors.bloomTier] : 0;

  const reputationWeight = 0.3;
  const normalizedReputation = Math.max(0, Math.min(1, factors.reputationScore / 100));

  const zoneWeight = factors.latencyZone ? getZoneWeight(factors.latencyZone) : 0.5;
  const latencyFactor = zoneWeight * 0.2;

  return (
    factors.matchScore * 0.4 +
    bloomBonus +
    normalizedReputation * reputationWeight +
    latencyFactor
  );
}

function getPeerScoringFactors(
  state: NodeState,
  peerId: string,
  matchScore: number,
  capability: string
): PeerScoringFactors {
  let bloomTier: FilterTier | null = null;
  if (state.bloomFilters) {
    const candidates = findCandidates(state.bloomFilters, capability, [peerId]);
    if (candidates.length > 0) {
      bloomTier = candidates[0].tier;
    }
  }

  let reputationScore = 0;
  if (state.reputationState) {
    const rep = getLocalReputation(state.reputationState, peerId);
    if (rep) {
      reputationScore = getEffectiveScore(rep);
    }
  }

  let latencyZone: LatencyZone | null = null;
  if (state.latencyZones) {
    latencyZone = getPeerZone(state.latencyZones, peerId) ?? null;
  }

  return {
    bloomTier,
    reputationScore,
    latencyZone,
    matchScore,
  };
}

function prioritizeWithAllFactors(
  state: NodeState,
  matches: CapabilityMatch[],
  capability: string
): CapabilityMatch[] {
  if (matches.length === 0) {
    return matches;
  }

  const scoredMatches = matches.map((match) => {
    const factors = getPeerScoringFactors(state, match.peer.id, match.matchScore, capability);
    const combinedScore = calculateCombinedScore(factors);
    return { match, combinedScore, factors };
  });

  scoredMatches.sort((a, b) => b.combinedScore - a.combinedScore);

  return scoredMatches.map((s) => ({
    ...s.match,
    score: s.combinedScore,
  }));
}

function prioritizeWithBloomFilter(
  state: NodeState,
  matches: CapabilityMatch[],
  capability: string
): CapabilityMatch[] {
  return prioritizeWithAllFactors(state, matches, capability);
}

const pollForMatches = async (
  stateRef: StateRef<NodeState>,
  query: CapabilityQuery,
  findMatchingPeers: (state: NodeState, query: CapabilityQuery) => CapabilityMatch[],
  maxWaitMs: number,
  pollIntervalMs = 100
): Promise<CapabilityMatch[]> => {
  const deadline = Date.now() + maxWaitMs;

  const checkMatches = (): CapabilityMatch[] => {
    const state = getState(stateRef);
    return findMatchingPeers(state, query);
  };

  let matches = checkMatches();
  if (matches.length > 0) return matches;

  while (Date.now() < deadline) {
    await delay(pollIntervalMs);
    matches = checkMatches();
    if (matches.length > 0) return matches;
  }

  return matches;
};

async function queryGossip(
  stateRef: StateRef<NodeState>,
  query: CapabilityQuery,
  timeoutMs = 2000
): Promise<CapabilityMatch[]> {
  await requestCapabilities(stateRef, query);
  return pollForMatches(stateRef, query, findMatchingPeers, timeoutMs);
}

export async function findPeers(
  stateRef: StateRef<NodeState>,
  query: CapabilityQuery
): Promise<CapabilityMatch[]> {
  let state = getState(stateRef);
  const peerList = getAllPeers(state);
  let matches = matchPeers(peerList, query);

  const primaryCapability = query.requiredCapabilities[0]?.type ?? 'unknown';

  const strategies = selectDiscoveryStrategy(
    matches,
    state.config,
    !!(state.node?.services.dht)
  );

  const hasGossipEnabled = state.config.discovery.includes('gossip');
  const shouldTryGossip = hasGossipEnabled && state.node?.services.pubsub;

  for (const strategy of strategies) {
    if (strategy === 'local') {
      if (shouldTryGossip) {
        const gossipMatches = await queryGossip(stateRef, query);
        if (gossipMatches.length > 0) {
          const existingMatchIds = new Set(matches.map(m => m.peer.id));
          const newMatches = gossipMatches.filter(m => !existingMatchIds.has(m.peer.id));
          matches = [...matches, ...newMatches];
        }
      }
      matches = prioritizeWithBloomFilter(state, matches, primaryCapability);
      return matches;
    }

    if (strategy === 'dht' && state.node?.services.dht) {
      const dhtPeers = await queryCapabilities(state.node, query);
      const newPeers = mergePeers(state.peers, dhtPeers);

      updateState(stateRef, (s) => addPeers(s, newPeers));

      state = getState(stateRef);
      const updatedPeerList = getAllPeers(state);
      matches = matchPeers(updatedPeerList, query);
      if (matches.length > 0) {
        matches = prioritizeWithBloomFilter(state, matches, primaryCapability);
        return matches;
      }
    }

    if (strategy === 'gossip') {
      matches = await queryGossip(stateRef, query);
      if (matches.length > 0) {
        matches = prioritizeWithBloomFilter(state, matches, primaryCapability);
        return matches;
      }
    }
  }

  return prioritizeWithBloomFilter(state, matches, primaryCapability);
}

function discoveryResultToPeerInfo(result: DiscoveryResult): PeerInfo {
  return {
    id: result.peer.id,
    addresses: result.peer.addresses,
    capabilities: [],
    lastSeen: result.peer.lastSeen,
  };
}

function sortByProximity(
  matches: CapabilityMatch[],
  proximityPeerIds: Set<string>
): CapabilityMatch[] {
  return [...matches].sort((a, b) => {
    const aIsProximity = proximityPeerIds.has(a.peer.id) ? 1 : 0;
    const bIsProximity = proximityPeerIds.has(b.peer.id) ? 1 : 0;
    return bIsProximity - aIsProximity;
  });
}

async function discoverInPhase(
  stateRef: StateRef<NodeState>,
  query: CapabilityQuery,
  phase: DiscoveryPriority,
  timeout: number
): Promise<CapabilityMatch[]> {
  const state = getState(stateRef);

  switch (phase) {
    case 'proximity': {
      if (!state.transport) {
        return [];
      }
      const proximityResults = getProximityPeers(state.transport);
      const peerInfos = proximityResults.map(discoveryResultToPeerInfo);
      updateState(stateRef, (s) => addPeers(s, peerInfos));
      const updatedState = getState(stateRef);
      return matchPeers(getAllPeers(updatedState), query);
    }

    case 'local': {
      if (state.transport) {
        const localResults = getPeersByPhase(state.transport, 'local');
        const peerInfos = localResults.map(discoveryResultToPeerInfo);
        updateState(stateRef, (s) => addPeers(s, peerInfos));
      }
      return queryGossip(stateRef, query, timeout);
    }

    case 'internet': {
      let matches: CapabilityMatch[] = [];

      if (state.node?.services.dht) {
        const dhtPeers = await queryCapabilities(state.node, query);
        const newPeers = mergePeers(state.peers, dhtPeers);
        updateState(stateRef, (s) => addPeers(s, newPeers));

        const updatedState = getState(stateRef);
        matches = matchPeers(getAllPeers(updatedState), query);
      }

      return matches;
    }

    case 'fallback': {
      return findPeers(stateRef, query);
    }
  }
}

export async function findPeersWithPriority(
  stateRef: StateRef<NodeState>,
  query: CapabilityQuery,
  config: PriorityDiscoveryConfig
): Promise<CapabilityMatch[]> {
  const state = getState(stateRef);
  let allMatches: CapabilityMatch[] = [];

  for (const phase of config.phases) {
    const phaseMatches = await discoverInPhase(stateRef, query, phase, config.phaseTimeout);

    const existingIds = new Set(allMatches.map((m) => m.peer.id));
    const newMatches = phaseMatches.filter((m) => !existingIds.has(m.peer.id));
    allMatches = [...allMatches, ...newMatches];

    if (allMatches.length >= config.minPeers) {
      break;
    }
  }

  if (config.preferProximity && state.transport) {
    const proximityPeerIds = new Set(
      getProximityPeers(state.transport).map((r) => r.peer.id)
    );
    allMatches = sortByProximity(allMatches, proximityPeerIds);
  }

  return allMatches;
}
