import { createLibp2p, type Libp2pOptions } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { mdns } from '@libp2p/mdns';
import { bootstrap } from '@libp2p/bootstrap';
import { kadDHT, passthroughMapper } from '@libp2p/kad-dht';
import { gossipsub } from '@libp2p/gossipsub';
import { signMessage } from '../services/auth';
import { matchPeers } from '../orchestrator/capability-matcher';
import {
  connect as connectRegistry,
  disconnect as disconnectRegistry,
  register as registerWithRegistry,
  unregister as unregisterFromRegistry,
  query as queryRegistryClient,
  type ClientState as RegistryClientState,
} from '../registry-client';
import * as storage from '../storage';
import { Pool } from '../connection';
import { publish } from './messaging';
import type { Capability } from '../types';
import { setupEventListeners } from './discovery';
import { announceCapabilities } from './capabilities';
import { connectToBootstrapPeers } from './bootstrap';
import { loadOrCreateNodeIdentity } from './identity';
import { createWalletState } from '../services/wallet';
import type { AuthState } from '../services/auth';
import {
  createStateRef,
  getState,
  setState,
  updateState,
  setNode,
  setMessageAuth,
  setWallet,
  setRegistryClient,
  addPeers,
} from './state';
import type { NodeState, EccoServices, StateRef } from './types';
import type { CapabilityQuery, CapabilityMatch, Message, PeerInfo } from '../types';
import type { MessageEvent } from '../events';

async function createLibp2pNode(stateRef: StateRef<NodeState>): Promise<void> {
  const state = getState(stateRef);

  const transportsList: Libp2pOptions<EccoServices>['transports'] = [tcp()];
  if (state.config.transport?.websocket?.enabled) {
    transportsList.push(webSockets());
  }

  const peerDiscoveryList: Libp2pOptions<EccoServices>['peerDiscovery'] = [];
  if (state.config.discovery.includes('mdns')) {
    peerDiscoveryList.push(mdns());
  }
  if (state.config.bootstrap?.enabled && state.config.bootstrap.peers && state.config.bootstrap.peers.length > 0) {
    peerDiscoveryList.push(
      bootstrap({
        list: state.config.bootstrap.peers,
        timeout: state.config.bootstrap.timeout || 30000,
      })
    );
  }

  const servicesConfig: Libp2pOptions<EccoServices>['services'] = {
    identify: identify(),
    ping: ping(),
  };

  if (state.config.discovery.includes('dht')) {
    Object.assign(servicesConfig, {
      dht: kadDHT({
        clientMode: false,
        protocol: '/ecco/kad/1.0.0',
        peerInfoMapper: passthroughMapper,
        allowQueryWithZeroPeers: true,
      }),
    });
  }

  if (state.config.discovery.includes('gossip')) {
    Object.assign(servicesConfig, { pubsub: gossipsub({ emitSelf: false, allowPublishToZeroTopicPeers: true }) });
  }

  const libp2pOptions: Libp2pOptions<EccoServices> = {
    addresses: { listen: ['/ip4/0.0.0.0/tcp/0'] },
    transports: transportsList,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: peerDiscoveryList,
    services: servicesConfig,
  };

  const node = await createLibp2p<EccoServices>(libp2pOptions);
  await node.start();
  console.log(`Ecco node started: ${state.id}`);
  console.log(`Listening on:`, node.getMultiaddrs().map(String));

  updateState(stateRef, (s) => setNode(s, node));
}

async function setupAuthentication(stateRef: StateRef<NodeState>): Promise<void> {
  const state = getState(stateRef);

  if (!(state.config.authentication?.enabled ?? false)) {
    return;
  }

  const identity = await loadOrCreateNodeIdentity(state.config);
  console.log(`Message authentication enabled (${identity.created ? 'generated new keys' : 'loaded keys'})`);

  const authState: AuthState = {
    config: {
      enabled: true,
      privateKey: identity.privateKey,
      publicKey: identity.publicKey,
    },
    keyCache: new Map(),
  };
  updateState(stateRef, (s) => setMessageAuth(s, authState));

  if (!state.config.nodeId) {
    updateState(stateRef, (current) => ({
      ...current,
      id: identity.nodeIdFromKeys
    }));
  }

  if (state.config.authentication?.walletAutoInit && identity.ethereumPrivateKey) {
    const walletState = createWalletState({
      privateKey: identity.ethereumPrivateKey,
      chains: [],
      rpcUrls: state.config.authentication.walletRpcUrls,
    });
    updateState(stateRef, (s) => setWallet(s, walletState));
    console.log('Wallet initialized with authentication keys');
  }
}

async function setupBootstrap(stateRef: StateRef<NodeState>): Promise<void> {
  const state = getState(stateRef);

  const shouldBootstrap = state.config.bootstrap?.enabled &&
                         state.config.bootstrap.peers &&
                         state.config.bootstrap.peers.length > 0;

  if (!shouldBootstrap) {
    return;
  }

  const result = await connectToBootstrapPeers(state);
  if (!result.success && result.error) {
    throw new Error(result.error);
  }
}

async function setupRegistry(stateRef: StateRef<NodeState>): Promise<void> {
  const state = getState(stateRef);

  if (!state.config.registry) {
    return;
  }

  const registryConfig = {
    url: state.config.registry,
    reconnect: true,
    reconnectInterval: 5000,
    timeout: 10000,
  };

  let connectedState: RegistryClientState | null = null;
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts && !connectedState) {
    try {
      connectedState = await Promise.race([
        connectRegistry(registryConfig),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Registry connection timeout')), 10000)
        ),
      ]);
    } catch (error) {
      attempts++;
      console.warn(`Registry connection attempt ${attempts} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);

      if (attempts < maxAttempts) {
        const delay = Math.min(2000 * Math.pow(2, attempts - 1), 10000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  if (!connectedState) {
    if (state.config.fallbackToP2P) {
      console.log('Failed to connect to registry, falling back to P2P discovery only');
      return;
    }
    throw new Error('Failed to connect to registry after multiple attempts');
  }

  updateState(stateRef, (s) => setRegistryClient(s, connectedState!));

  const updatedState = getState(stateRef);
  if (updatedState.node) {
    const addresses = updatedState.node.getMultiaddrs().map(String);
    const registeredState = await registerWithRegistry(connectedState, updatedState.id, updatedState.capabilities, addresses);
    updateState(stateRef, (s) => setRegistryClient(s, registeredState));
  }
}

async function initializeStorage(stateRef: StateRef<NodeState>): Promise<void> {
  const state = getState(stateRef);
  await storage.initialize(state.id);

  const [
    escrowAgreements,
    paymentLedger,
    streamingChannels,
    stakePositions,
    swarmSplits,
    pendingSettlements,
  ] = await Promise.all([
    storage.loadEscrowAgreements(),
    storage.loadPaymentLedger(),
    storage.loadStreamingChannels(),
    storage.loadStakePositions(),
    storage.loadSwarmSplits(),
    storage.loadPendingSettlements(),
  ]);

  updateState(stateRef, (currentState) => ({
    ...currentState,
    escrowAgreements,
    paymentLedger,
    streamingChannels,
    stakePositions,
    swarmSplits,
    pendingSettlements,
  }));
}

export async function start(state: NodeState): Promise<StateRef<NodeState>> {
  const stateRef = createStateRef(state);

  await initializeStorage(stateRef);
  await setupAuthentication(stateRef);
  await createLibp2pNode(stateRef);
  setupEventListeners(getState(stateRef), stateRef);
  await setupBootstrap(stateRef);
  await setupRegistry(stateRef);
  await announceCapabilities(getState(stateRef));

  return stateRef;
}

export async function stop(stateRef: StateRef<NodeState>): Promise<void> {
  const state = getState(stateRef);

  if (state.registryClient) {
    await unregisterFromRegistry(state.registryClient);
    await disconnectRegistry(state.registryClient);
  }

  if (state.connectionPool) {
    await Pool.close(state.connectionPool);
  }

  if (state.node) {
    await state.node.stop();
    console.log('Ecco node stopped');
  }
}

namespace PeerDiscoveryLogic {
  export type DiscoveryStrategy = 'local' | 'registry' | 'dht' | 'gossip';

  export function selectDiscoveryStrategy(
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

  export function mergePeers(
    existingPeers: Record<string, PeerInfo>,
    newPeers: PeerInfo[]
  ): PeerInfo[] {
    return newPeers.filter(peer => !existingPeers[peer.id]);
  }
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

  const { multiaddr } = await import('@multiformats/multiaddr');

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

async function queryGossip(
  stateRef: StateRef<NodeState>,
  query: CapabilityQuery,
  timeoutMs = 2000
): Promise<CapabilityMatch[]> {
  console.log('No local matches, broadcasting capability request...');
  const { requestCapabilities, findMatchingPeers } = await import('./capabilities');
  const state = getState(stateRef);

  await requestCapabilities(stateRef, query);
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));

  const updatedState = getState(stateRef);
  return findMatchingPeers(updatedState, query);
}

export async function findPeers(
  stateRef: StateRef<NodeState>,
  query: CapabilityQuery
): Promise<CapabilityMatch[]> {
  let state = getState(stateRef);
  const peerList = Object.values(state.peers);
  let matches = matchPeers(peerList, query);

  const isRegistryConnected = state.registryClient?.connected ?? false;

  const strategies = PeerDiscoveryLogic.selectDiscoveryStrategy(
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
      const newPeers = PeerDiscoveryLogic.mergePeers(state.peers, registryPeers);

      updateState(stateRef, (s) => addPeers(s, newPeers));

      if (state.node && newPeers.length > 0) {
        await dialRegistryPeers(state.node, newPeers);
      }

      state = getState(stateRef);
      await new Promise((resolve) => setTimeout(resolve, 2000));

      state = getState(stateRef);
      const updatedPeerList = Object.values(state.peers);
      matches = matchPeers(updatedPeerList, query);
      if (matches.length > 0) {
        return matches;
      }
    }

    if (strategy === 'dht' && state.node?.services.dht) {
      console.log('No matches from registry, querying DHT...');
      const currentNode = state.node;
      const { DHT } = await import('./dht');
      const dhtPeers = await DHT.queryCapabilities(currentNode, query);
      const newPeers = PeerDiscoveryLogic.mergePeers(state.peers, dhtPeers);

      updateState(stateRef, (s) => addPeers(s, newPeers));

      state = getState(stateRef);
      const updatedPeerList = Object.values(state.peers);
      matches = matchPeers(updatedPeerList, query);
      if (matches.length > 0) {
        return matches;
      }
    }

    if (strategy === 'gossip') {
      matches = await queryGossip(stateRef, query);
      if (matches.length > 0) {
        return matches;
      }
    }
  }

  return matches;
}

export async function sendMessage(
  stateRef: StateRef<NodeState>,
  peerId: string,
  message: Message
): Promise<void> {
  const state = getState(stateRef);

  const maxAttempts = state.config.retry?.maxAttempts || 3;
  const initialDelay = state.config.retry?.initialDelay || 1000;
  const maxDelay = state.config.retry?.maxDelay || 10000;

  let attempt = 0;
  let lastError: Error | undefined;

  while (attempt < maxAttempts) {
    try {
      let messageToSend = message;
      if (state.messageAuth) {
        messageToSend = await signMessage(state.messageAuth, message);
      }

      const messageEvent: MessageEvent = {
        type: 'message',
        from: messageToSend.from,
        to: messageToSend.to,
        payload: messageToSend,
        timestamp: Date.now(),
      };

      if (state.connectionPool) {
        await publish(state, `peer:${peerId}`, messageEvent);
      } else {
        await publish(state, `peer:${peerId}`, messageEvent);
      }
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown error');
      attempt++;

      if (attempt < maxAttempts) {
        const delay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  console.warn(`Failed to send message to ${peerId}: ${lastError?.message ?? 'Unknown error'}`);
  throw lastError;
}
