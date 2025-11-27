import type { PeerId } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import type { NodeState, StateRef } from './types';
import type { CapabilityQuery, CapabilityMatch, PeerInfo } from '../types';
import type { ClientState as RegistryClientState } from '../registry-client';
import { query as queryRegistryClient } from '../registry-client';
import { matchPeers } from '../orchestrator/capability-matcher';
import { announceCapabilities, setupCapabilityTracking, requestCapabilities, findMatchingPeers } from './capabilities';
import { setupPerformanceTracking } from './peer-performance';
import { getState, updateState, removePeer, addPeers } from './state';
import { delay } from '../utils';
import { queryCapabilities } from './dht';

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

export function setupEventListeners(
  state: NodeState,
  stateRef: StateRef<NodeState>
): void {
  if (!state.node) {
    return;
  }

  const node = state.node;
  const discoveredPeers = new Set<string>();
  const bootstrapPeerIds = getBootstrapPeerIds(state.config);

  node.addEventListener('peer:discovery', async (evt: CustomEvent<{ id: PeerId; multiaddrs: unknown[] }>) => {
    const { id: peerId } = evt.detail;
    const peerIdStr = peerId.toString();

    if (discoveredPeers.has(peerIdStr)) {
      return;
    }

    discoveredPeers.add(peerIdStr);
    console.log(`[${state.id}] Discovered peer: ${peerIdStr}`);

    if (bootstrapPeerIds.has(peerIdStr)) {
      return;
    }

    try {
      await node.dial(peerId);
      console.log(`[${state.id}] Dialed peer: ${peerIdStr}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (!errorMessage.includes('ECONNREFUSED') && !errorMessage.includes('timeout')) {
        console.warn(`[${state.id}] Failed to dial peer: ${peerIdStr}`, errorMessage);
      }
    }
  });

  node.addEventListener('peer:connect', (evt: CustomEvent<PeerId>) => {
    const peerId = evt.detail.toString();
    console.log('Connected to peer:', peerId);
    
    const currentState = getState(stateRef);
    if (!currentState.peers[peerId]) {
      const peerAddresses = node.getConnections()
        .filter(conn => conn.remotePeer.toString() === peerId)
        .flatMap(conn => conn.remoteAddr ? [conn.remoteAddr.toString()] : []);
      
      updateState(stateRef, (s) => addPeers(s, [{
        id: peerId,
        addresses: peerAddresses,
        capabilities: [],
        lastSeen: Date.now(),
      }]));
    }
    
    handlePeerConnect(stateRef).catch(() => {});
  });

  node.addEventListener('peer:disconnect', (evt: CustomEvent<PeerId>) => {
    const peerId = evt.detail.toString();
    console.log('Disconnected from peer:', peerId);
    updateState(stateRef, (s) => removePeer(s, peerId));
  });
}

async function handlePeerConnect(stateRef: StateRef<NodeState>): Promise<void> {
  setupCapabilityTracking(stateRef);
  updateState(stateRef, setupPerformanceTracking);
  const state = getState(stateRef);
  await announceCapabilities(state);
}

type DiscoveryStrategy = 'local' | 'registry' | 'dht' | 'gossip';

function selectDiscoveryStrategy(
  localMatches: CapabilityMatch[],
  config: NodeState['config'],
  hasRegistry: boolean,
  hasDHT: boolean
): DiscoveryStrategy[] {
  if (localMatches.length > 0) {
    return ['local'];
  }

  const strategies: DiscoveryStrategy[] = [];

  if (hasRegistry) {
    strategies.push('registry');
  }

  if (config.discovery.includes('dht') && hasDHT) {
    strategies.push('dht');
  }

  if (config.discovery.includes('gossip')) {
    strategies.push('gossip');
  }

  return strategies;
}

function mergePeers(
  existingPeers: Record<string, PeerInfo>,
  newPeers: PeerInfo[]
): PeerInfo[] {
  return newPeers.filter(peer => !existingPeers[peer.id]);
}

async function queryRegistry(
  registryClient: RegistryClientState,
  query: CapabilityQuery
): Promise<PeerInfo[]> {
  console.log('No local matches, querying registry...');
  try {
    return await queryRegistryClient(registryClient, query);
  } catch (error) {
    console.error('Registry query failed:', error);
    return [];
  }
}

async function dialRegistryPeers(
  node: NodeState['node'],
  peers: PeerInfo[]
): Promise<void> {
  if (!node) {
    return;
  }

  for (const peer of peers) {
    if (peer.addresses.length === 0) {
      continue;
    }

    for (const addrStr of peer.addresses) {
      try {
        const addr = multiaddr(addrStr);
        await node.dial(addr);
        console.log(`Dialed registry peer ${peer.id} at ${addrStr}`);
        break;
      } catch {
        continue;
      }
    }
  }
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
  const peerList = Object.values(state.peers);
  let matches = matchPeers(peerList, query);

  const isRegistryConnected = state.registryClient?.connected ?? false;

  const strategies = selectDiscoveryStrategy(
    matches,
    state.config,
    isRegistryConnected,
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
      return matches;
    }

    if (strategy === 'registry' && state.registryClient) {
      const registryPeers = await queryRegistry(state.registryClient, query);
      const newPeers = mergePeers(state.peers, registryPeers);

      updateState(stateRef, (s) => addPeers(s, newPeers));

      state = getState(stateRef);
      const updatedPeerList = Object.values(state.peers);
      matches = matchPeers(updatedPeerList, query);

      if (matches.length > 0) {
        if (state.node && newPeers.length > 0) {
          dialRegistryPeers(state.node, newPeers);
        }
        return matches;
      }
    }

    if (strategy === 'dht' && state.node?.services.dht) {
      console.log('No matches from registry, querying DHT...');
      const dhtPeers = await queryCapabilities(state.node, query);
      const newPeers = mergePeers(state.peers, dhtPeers);

      updateState(stateRef, (s) => addPeers(s, newPeers));

      state = getState(stateRef);
      const updatedPeerList = Object.values(state.peers);
      matches = matchPeers(updatedPeerList, query);
      if (matches.length > 0) {
        return matches;
      }
    }

    if (strategy === 'gossip') {
      console.log('No local matches, querying via gossip...');
      matches = await queryGossip(stateRef, query);
      if (matches.length > 0) {
        return matches;
      }
    }
  }

  return matches;
}
