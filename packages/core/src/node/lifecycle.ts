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
import { withTimeout, retryWithBackoff } from '../utils';
import {
  connect as connectRegistry,
  disconnect as disconnectRegistry,
  register as registerWithRegistry,
  unregister as unregisterFromRegistry,
  type ClientState as RegistryClientState,
} from '../registry-client';
import * as storage from '../storage';
import { closePool } from '../connection';
import { publish } from './messaging';
import { setupEventListeners } from './discovery';
import { announceCapabilities } from './capabilities';
import { connectToBootstrapPeers } from './bootstrap';
import { loadOrCreateNodeIdentity } from './identity';
import { createWalletState } from '../services/wallet';
import type { AuthState } from '../services/auth';
import {
  createStateRef,
  getState,
  updateState,
  setNode,
  setMessageAuth,
  setWallet,
  setRegistryClient,
} from './state';
import type { NodeState, EccoServices, StateRef } from './types';
import type { Message } from '../types';
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

  try {
    connectedState = await retryWithBackoff(
      () => withTimeout(connectRegistry(registryConfig), 10000, 'Registry connection timeout'),
      {
        maxAttempts: 3,
        initialDelay: 2000,
        maxDelay: 10000,
        onRetry: (attempt, error) => {
          console.warn(`Registry connection attempt ${attempt} failed: ${error.message}`);
        },
      }
    );
  } catch {
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
    await closePool(state.connectionPool);
  }

  if (state.node) {
    await state.node.stop();
    console.log('Ecco node stopped');
  }
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

  try {
    await retryWithBackoff(
      async () => {
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

        await publish(state, `peer:${peerId}`, messageEvent);
      },
      {
        maxAttempts,
        initialDelay,
        maxDelay,
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`Failed to send message to ${peerId}: ${errorMessage}`);
    throw error;
  }
}
