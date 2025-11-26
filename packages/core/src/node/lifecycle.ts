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
  setTransport,
  setMessageBridge,
} from './state';
import type { NodeState, EccoServices, StateRef } from './types';
import type { Message } from '../types';
import type { MessageEvent } from '../events';
import {
  createHybridDiscovery,
  registerAdapter as registerHybridAdapter,
  startDiscovery as startHybridDiscovery,
  stopDiscovery as stopHybridDiscovery,
  onMessage as onHybridMessage,
} from '../transport/hybrid-discovery';
import { createLibp2pAdapter, toAdapter as toLibp2pAdapter, initialize as initLibp2pAdapter } from '../transport/adapters/libp2p';
import {
  createBLEAdapter,
  toAdapter as toBLEAdapter,
  setLocalContext as setBLELocalContext,
} from '../transport/adapters/bluetooth-le';
import {
  createWebRTCAdapter,
  toAdapter as toWebRTCAdapter,
  initialize as initWebRTCAdapter,
} from '../transport/adapters/webrtc';
import {
  createMessageBridge,
  setAuthState as setMessageBridgeAuth,
  handleIncomingBroadcast,
} from '../transport/message-bridge';
import type { LocalContext } from '../transport/types';

function buildListenAddresses(config: NodeState['config']): string[] {
  if (config.listenAddresses && config.listenAddresses.length > 0) {
    return config.listenAddresses;
  }

  const addresses = ['/ip4/0.0.0.0/tcp/0'];

  if (config.transport?.websocket?.enabled) {
    const wsPort = config.transport.websocket.port ?? 0;
    addresses.push(`/ip4/0.0.0.0/tcp/${wsPort}/ws`);
  }

  return addresses;
}

function buildDHTProtocol(networkId?: string): string {
  const baseProtocol = '/ecco/kad/1.0.0';
  if (networkId) {
    return `${baseProtocol}/${networkId}`;
  }
  return baseProtocol;
}

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
        protocol: buildDHTProtocol(state.config.networkId),
        peerInfoMapper: passthroughMapper,
        allowQueryWithZeroPeers: true,
      }),
    });
  }

  if (state.config.discovery.includes('gossip')) {
    Object.assign(servicesConfig, { pubsub: gossipsub({ emitSelf: false, allowPublishToZeroTopicPeers: true }) });
  }

  const listenAddresses = buildListenAddresses(state.config);

  const libp2pOptions: Libp2pOptions<EccoServices> = {
    addresses: { listen: listenAddresses },
    transports: transportsList,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: peerDiscoveryList,
    services: servicesConfig,
  };

  const node = await createLibp2p<EccoServices>(libp2pOptions);
  await node.start();
  console.log(`Ecco node started: ${state.id}`);
  if (state.config.networkId) {
    console.log(`Network: ${state.config.networkId}`);
  }
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

async function setupTransport(stateRef: StateRef<NodeState>): Promise<void> {
  const state = getState(stateRef);
  
  if (!state.node) {
    return;
  }

  const hasGossipEnabled = state.config.discovery.includes('gossip');
  const hasProximityConfig = state.config.proximity?.bluetooth?.enabled ||
                             state.config.proximity?.wifiDirect?.enabled ||
                             state.config.proximity?.nfc?.enabled;
  const hasWebRTCConfig = state.config.transport?.webrtc?.enabled;
  
  const shouldSetupTransport = hasGossipEnabled ||
                               hasProximityConfig || 
                               hasWebRTCConfig ||
                               state.config.discovery.includes('bluetooth');

  if (!shouldSetupTransport) {
    return;
  }

  let messageBridge = createMessageBridge({
    nodeId: state.id,
    authEnabled: state.config.authentication?.enabled ?? false,
  });

  if (state.messageAuth) {
    messageBridge = setMessageBridgeAuth(messageBridge, state.messageAuth);
  }

  updateState(stateRef, (s) => setMessageBridge(s, messageBridge));

  let hybridDiscovery = createHybridDiscovery({
    phases: ['proximity', 'local', 'internet', 'fallback'],
    phaseTimeout: 5000,
    autoEscalate: true,
    preferProximity: true,
  });

  const libp2pAdapterState = createLibp2pAdapter({ node: state.node });
  const initializedAdapter = initLibp2pAdapter(libp2pAdapterState);
  hybridDiscovery = registerHybridAdapter(hybridDiscovery, toLibp2pAdapter(initializedAdapter));

  if (state.config.proximity?.bluetooth?.enabled) {
    const localContext: LocalContext = {
      locationId: state.config.proximity.localContext?.locationId,
      locationName: state.config.proximity.localContext?.locationName,
      capabilities: state.config.proximity.localContext?.capabilities ?? 
                    state.capabilities.map(c => c.name),
      metadata: state.config.proximity.localContext?.metadata,
    };

    let bleAdapterState = createBLEAdapter({
      serviceUUID: state.config.proximity.bluetooth.serviceUUID,
      advertise: state.config.proximity.bluetooth.advertise ?? true,
      scan: state.config.proximity.bluetooth.scan ?? true,
    });
    
    bleAdapterState = setBLELocalContext(bleAdapterState, localContext);
    hybridDiscovery = registerHybridAdapter(hybridDiscovery, toBLEAdapter(bleAdapterState));
    console.log('BLE adapter registered for proximity discovery');
  }

  if (state.config.transport?.webrtc?.enabled) {
    const webrtcAdapterState = createWebRTCAdapter(state.id, {
      signalingServer: state.config.transport.webrtc.signalingServer,
      iceServers: state.config.transport.webrtc.iceServers,
    });
    
    const initializedWebRTC = await initWebRTCAdapter(webrtcAdapterState);
    hybridDiscovery = registerHybridAdapter(hybridDiscovery, toWebRTCAdapter(initializedWebRTC));
    console.log('WebRTC adapter registered for internet-phase discovery');
  }

  hybridDiscovery = await startHybridDiscovery(hybridDiscovery);

  onHybridMessage(hybridDiscovery, async (peerId, transportMessage) => {
    const currentState = getState(stateRef);
    if (currentState.messageBridge) {
      const updatedBridge = await handleIncomingBroadcast(
        currentState.messageBridge,
        peerId,
        transportMessage
      );
      updateState(stateRef, (s) => setMessageBridge(s, updatedBridge));
    }
  });

  updateState(stateRef, (s) => setTransport(s, hybridDiscovery));
  console.log('Transport layer initialized with hybrid discovery');
}

export async function start(state: NodeState): Promise<StateRef<NodeState>> {
  const stateRef = createStateRef(state);

  await initializeStorage(stateRef);
  await setupAuthentication(stateRef);
  await createLibp2pNode(stateRef);
  setupEventListeners(getState(stateRef), stateRef);
  await setupBootstrap(stateRef);
  await setupRegistry(stateRef);
  await setupTransport(stateRef);
  await announceCapabilities(getState(stateRef));

  return stateRef;
}

export async function stop(stateRef: StateRef<NodeState>): Promise<void> {
  const state = getState(stateRef);

  if (state.transport) {
    await stopHybridDiscovery(state.transport);
  }

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
        const currentState = getState(stateRef);
        
        if (currentState.messageBridge && currentState.transport) {
          const { publishDirect } = await import('./messaging');
          await publishDirect(currentState, peerId, message);
          return;
        }

        let messageToSend = message;
        if (currentState.messageAuth) {
          messageToSend = await signMessage(currentState.messageAuth, message);
        }

        const messageEvent: MessageEvent = {
          type: 'message',
          from: messageToSend.from,
          to: messageToSend.to,
          payload: messageToSend,
          timestamp: Date.now(),
        };

        await publish(currentState, `peer:${peerId}`, messageEvent);
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
