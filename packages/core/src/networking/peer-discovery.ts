import type { PeerId } from '@libp2p/interface';
import type { NodeState, StateRef } from './types';
import type { CapabilityQuery, CapabilityMatch, PeerInfo } from '../types';
import { matchPeers } from '../orchestrator/capability-matcher';
import { announceCapabilities, requestCapabilities, findMatchingPeers } from './capabilities';
import { setupPerformanceTracking } from '../reputation/peer-performance';
import { getState, updateState, removePeer, addPeers, hasPeer, getAllPeers, setMessageBridge, registerCleanup } from './state';
import { delay, debug } from '../utils';
import { queryCapabilities } from './dht';
import type { LRUCache } from '../utils/lru-cache';
import type { PriorityDiscoveryConfig, DiscoveryPriority } from '../agent/types';
import { getProximityPeers, getPeersByPhase, type DiscoveryResult } from './hybrid-discovery';
import { findCandidates, type FilterTier } from '../reputation/reputation-filter';
import { getLocalReputation, getDiscoveryReputationScore, createReputationScorer, resolveAndSyncPeer } from '../reputation/reputation-state';
import { getPeerZone, getZoneWeight, type LatencyZone } from '../reputation/latency-zones';
import { initiateHandshake, isHandshakeRequired, removePeerValidation, type MessageBridgeState } from './message-bridge';
import { removeAllTopicSubscriptionsForPeer } from './messaging';
import { DISCOVERY } from './constants';

async function sendHandshakeMessage(
  stateRef: StateRef<NodeState>,
  messageBridge: MessageBridgeState,
  peerId: string
): Promise<void> {
  try {
    const { message } = await initiateHandshake(messageBridge, peerId);
    debug('discovery', `initiateHandshake returned: message=${!!message}`);
    if (message) {
      const bridge = getState(stateRef).messageBridge;
      if (bridge?.sendMessage) {
        debug('discovery', `Sending handshake to ${peerId}`);
        await bridge.sendMessage(peerId, message);
        debug('discovery', `Handshake sent to ${peerId}`);
      } else {
        debug('discovery', `No sendMessage on bridge`);
      }
    }
  } catch (err) {
    debug('discovery', `Handshake error: ${err}`);
  }
}


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

function cleanupStaleEntries(discoveredPeers: Map<string, number>): void {
  const now = Date.now();
  for (const [peerId, timestamp] of discoveredPeers) {
    if (now - timestamp > DISCOVERY.CACHE_TTL_MS) {
      discoveredPeers.delete(peerId);
    }
  }
  if (discoveredPeers.size > DISCOVERY.MAX_DISCOVERED_PEERS) {
    const entries = Array.from(discoveredPeers.entries())
      .sort((a, b) => a[1] - b[1]);
    const toRemove = entries.slice(0, discoveredPeers.size - DISCOVERY.MAX_DISCOVERED_PEERS);
    for (const [peerId] of toRemove) {
      discoveredPeers.delete(peerId);
    }
  }
}

function getProximityPeerIds(state: NodeState): Set<string> | undefined {
  if (!state.transport) {
    return undefined;
  }
  const proximityPeers = getProximityPeers(state.transport);
  if (proximityPeers.length === 0) {
    return undefined;
  }
  return new Set(proximityPeers.map((result) => result.peer.id));
}

async function syncReputationForMatches(
  stateRef: StateRef<NodeState>,
  matches: CapabilityMatch[]
): Promise<void> {
  if (matches.length === 0) {
    return;
  }
  const state = getState(stateRef);
  const reputationState = state.reputationState;
  const wallet = state.wallet;
  if (!reputationState || !wallet) {
    return;
  }

  await Promise.allSettled(
    matches.map((match) => resolveAndSyncPeer(reputationState, wallet, match.peer.id))
  );
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
  const abortController = new AbortController();
  const dialQueue: { peerId: PeerId; peerIdStr: string }[] = [];
  const queuedPeers = new Set<string>();
  const inFlightDials = new Set<string>();
  const connectedPeers = new Set(
    node.getConnections().map((conn) => conn.remotePeer.toString().toLowerCase())
  );
  let nextDialAllowedAt = 0;
  let dialBackoffMs: number = DISCOVERY.DIAL_BACKOFF_BASE_MS;

  const removeQueuedPeer = (peerIdLower: string): void => {
    if (dialQueue.length === 0) {
      return;
    }
    for (let i = dialQueue.length - 1; i >= 0; i -= 1) {
      const candidate = dialQueue[i];
      if (candidate && candidate.peerIdStr.toLowerCase() === peerIdLower) {
        queuedPeers.delete(candidate.peerIdStr);
        dialQueue.splice(i, 1);
      }
    }
  };

  const enqueueDial = (peerId: PeerId, peerIdStr: string): void => {
    if (connectedPeers.has(peerIdStr.toLowerCase())) {
      return;
    }
    if (queuedPeers.has(peerIdStr) || inFlightDials.has(peerIdStr)) {
      return;
    }
    dialQueue.push({ peerId, peerIdStr });
    queuedPeers.add(peerIdStr);
  };

  const dialTimer = setInterval(() => {
    if (dialQueue.length === 0 || inFlightDials.size >= DISCOVERY.DIAL_MAX_CONCURRENT) {
      return;
    }
    const now = Date.now();
    if (now < nextDialAllowedAt) {
      return;
    }

    while (inFlightDials.size < DISCOVERY.DIAL_MAX_CONCURRENT && dialQueue.length > 0) {
      const candidate = dialQueue.shift();
      if (!candidate) {
        return;
      }
      queuedPeers.delete(candidate.peerIdStr);
      if (connectedPeers.has(candidate.peerIdStr.toLowerCase())) {
        continue;
      }
      if (node.getConnections(candidate.peerId).length > 0) {
        connectedPeers.add(candidate.peerIdStr.toLowerCase());
        continue;
      }
      if (inFlightDials.has(candidate.peerIdStr)) {
        continue;
      }

      const startTime = Date.now();
      if (startTime < nextDialAllowedAt) {
        dialQueue.unshift(candidate);
        queuedPeers.add(candidate.peerIdStr);
        return;
      }

      inFlightDials.add(candidate.peerIdStr);
      nextDialAllowedAt = startTime + dialBackoffMs;

      node.dial(candidate.peerId)
        .then(() => {
          dialBackoffMs = DISCOVERY.DIAL_BACKOFF_BASE_MS;
          connectedPeers.add(candidate.peerIdStr.toLowerCase());
        })
        .catch((error) => {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          if (!errorMessage.includes('ECONNREFUSED') && !errorMessage.includes('timeout')) {
            console.warn(`[${state.id}] Failed to dial peer: ${candidate.peerIdStr}`, errorMessage);
          }
          dialBackoffMs = Math.min(DISCOVERY.DIAL_BACKOFF_MAX_MS, dialBackoffMs * 2);
          const nextAllowed = Date.now() + dialBackoffMs;
          if (nextAllowed > nextDialAllowedAt) {
            nextDialAllowedAt = nextAllowed;
          }
        })
        .finally(() => {
          inFlightDials.delete(candidate.peerIdStr);
        });
    }
  }, DISCOVERY.DIAL_QUEUE_TICK_MS);

  node.addEventListener('peer:discovery', (evt: CustomEvent<{ id: PeerId; multiaddrs: unknown[] }>) => {
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

    enqueueDial(peerId, peerIdStr);
  }, { signal: abortController.signal });

  node.addEventListener('peer:connect', (evt: CustomEvent<PeerId>) => {
    const peerId = evt.detail.toString();
    connectedPeers.add(peerId.toLowerCase());
    removeQueuedPeer(peerId.toLowerCase());
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
      debug('discovery', `Peer connected: ${peerId}, initiating handshake`);
      updateState(stateRef, (s) => {
        if (!s.messageBridge) return s;
        if (s.messageBridge.validatedPeers.has(peerId)) return s;
        if (s.messageBridge.pendingHandshakes.has(peerId)) return s;
        const pendingHandshakes = new Map(s.messageBridge.pendingHandshakes);
        pendingHandshakes.set(peerId, { initiated: Date.now() });
        return setMessageBridge(s, { ...s.messageBridge, pendingHandshakes });
      });
      debug('discovery', `Added ${peerId} to pendingHandshakes`);
      sendHandshakeMessage(stateRef, currentState.messageBridge, peerId);
    } else {
      debug('discovery', `Peer connected: ${peerId}, handshake not required`);
    }

    handlePeerConnect(stateRef).catch(() => {});
  }, { signal: abortController.signal });

  node.addEventListener('peer:disconnect', (evt: CustomEvent<PeerId>) => {
    const peerId = evt.detail.toString();
    connectedPeers.delete(peerId.toLowerCase());
    discoveredPeers.delete(peerId);
    removeAllTopicSubscriptionsForPeer(stateRef, peerId);
    const currentState = getState(stateRef);
    if (currentState.messageBridge) {
      const updatedBridge = removePeerValidation(currentState.messageBridge, peerId);
      updateState(stateRef, (s) => ({ ...removePeer(s, peerId), messageBridge: updatedBridge }));
    } else {
      updateState(stateRef, (s) => removePeer(s, peerId));
    }
  }, { signal: abortController.signal });

  registerCleanup(stateRef, () => {
    abortController.abort();
    clearInterval(dialTimer);
    dialQueue.length = 0;
    queuedPeers.clear();
    inFlightDials.clear();
    connectedPeers.clear();
  });
}

async function handlePeerConnect(stateRef: StateRef<NodeState>): Promise<void> {
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
  proximityBonus: number;
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
  capability: string,
  proximityPeerIds?: Set<string>
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
      reputationScore = getDiscoveryReputationScore(rep);
    }
  }

  let latencyZone: LatencyZone | null = null;
  if (state.latencyZones) {
    latencyZone = getPeerZone(state.latencyZones, peerId) ?? null;
  }

  const proximityBonus = proximityPeerIds && proximityPeerIds.has(peerId) ? 1 : 0;

  return {
    bloomTier,
    reputationScore,
    latencyZone,
    matchScore,
    proximityBonus,
  };
}

function prioritizeWithAllFactors(
  state: NodeState,
  matches: CapabilityMatch[],
  capability: string,
  proximityPeerIds?: Set<string>
): CapabilityMatch[] {
  if (matches.length === 0) {
    return matches;
  }

  const scoredMatches = matches.map((match) => {
    const factors = getPeerScoringFactors(state, match.peer.id, match.matchScore, capability, proximityPeerIds);
    const combinedScore = calculateCombinedScore(factors);
    return { match, combinedScore, factors };
  });

  scoredMatches.sort((a, b) => {
    const repDiff = b.factors.reputationScore - a.factors.reputationScore;
    if (repDiff !== 0) {
      return repDiff;
    }
    const proximityDiff = b.factors.proximityBonus - a.factors.proximityBonus;
    if (proximityDiff !== 0) {
      return proximityDiff;
    }
    return b.combinedScore - a.combinedScore;
  });

  return scoredMatches.map((s) => ({
    ...s.match,
    peer: { ...s.match.peer, reputation: s.factors.reputationScore },
    score: s.combinedScore,
  }));
}

function prioritizeWithBloomFilter(
  state: NodeState,
  matches: CapabilityMatch[],
  capability: string,
  proximityPeerIds?: Set<string>
): CapabilityMatch[] {
  return prioritizeWithAllFactors(state, matches, capability, proximityPeerIds);
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

  while (true) {
    const now = Date.now();
    if (now >= deadline) {
      break;
    }
    const remainingMs = deadline - now;
    const waitMs = Math.min(pollIntervalMs, remainingMs);
    await delay(waitMs);

    if (Date.now() >= deadline) {
      break;
    }
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
      await syncReputationForMatches(stateRef, matches);
      state = getState(stateRef);
      matches = prioritizeWithBloomFilter(state, matches, primaryCapability, getProximityPeerIds(state));
      return matches;
    }

    if (strategy === 'dht' && state.node?.services.dht) {
      const scorer = createReputationScorer(state.reputationState);
      const dhtPeers = await queryCapabilities(state.node, query, scorer);
      const newPeers = mergePeers(state.peers, dhtPeers);

      updateState(stateRef, (s) => addPeers(s, newPeers));

      state = getState(stateRef);
      const updatedPeerList = getAllPeers(state);
      matches = matchPeers(updatedPeerList, query);
      if (matches.length > 0) {
        await syncReputationForMatches(stateRef, matches);
        state = getState(stateRef);
        matches = prioritizeWithBloomFilter(state, matches, primaryCapability, getProximityPeerIds(state));
        return matches;
      }
    }

    if (strategy === 'gossip') {
      matches = await queryGossip(stateRef, query);
      if (matches.length > 0) {
        await syncReputationForMatches(stateRef, matches);
        state = getState(stateRef);
        matches = prioritizeWithBloomFilter(state, matches, primaryCapability, getProximityPeerIds(state));
        return matches;
      }
    }
  }

  await syncReputationForMatches(stateRef, matches);
  state = getState(stateRef);
  return prioritizeWithBloomFilter(state, matches, primaryCapability, getProximityPeerIds(state));
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
        const scorer = createReputationScorer(state.reputationState);
        const dhtPeers = await queryCapabilities(state.node, query, scorer);
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

  await syncReputationForMatches(stateRef, allMatches);

  const updatedState = getState(stateRef);
  const proximityPeerIds = config.preferProximity ? getProximityPeerIds(updatedState) : undefined;
  const primaryCapability = query.requiredCapabilities[0]?.type ?? 'unknown';
  return prioritizeWithBloomFilter(updatedState, allMatches, primaryCapability, proximityPeerIds);
}
