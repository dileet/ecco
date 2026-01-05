import { createLibp2p, type Libp2pOptions } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { pureJsCrypto } from '../transport/noise-crypto';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { mdns } from '@libp2p/mdns';
import { kadDHT, passthroughMapper } from '@libp2p/kad-dht';
import { gossipsub } from '@libp2p/gossipsub';
import { signMessage, createPublicKeyCache } from '../services/auth';
import { withTimeout, retryWithBackoff, debug } from '../utils';
import * as storage from '../storage';
import { closePool } from '../connection';
import { publish } from './messaging';
import { setupEventListeners } from './discovery';
import { announceCapabilities, setupCapabilityTracking } from './capabilities';
import { connectToBootstrapPeers } from './bootstrap';
import { loadOrCreateNodeIdentity } from './identity';
import { createWalletState } from '../services/wallet';
import { SDK_PROTOCOL_VERSION, formatProtocolVersion } from '../networks';
import type { AuthState } from '../services/auth';
import {
  createStateRef,
  getState,
  updateState,
  setNode,
  setMessageAuth,
  setWallet,
  setTransport,
  setMessageBridge,
  runCleanupHandlers,
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
  initialize as initBLEAdapter,
  toAdapter as toBLEAdapter,
  setLocalContext as setBLELocalContext,
} from '../transport/adapters/bluetooth-le';
import {
  createMessageBridge,
  setAuthState as setMessageBridgeAuth,
  setHandshakeCallbacks,
  handleIncomingBroadcast,
  handleVersionHandshake,
  handleVersionHandshakeResponse,
  handleVersionIncompatibleNotice,
  handleConstitutionMismatchNotice,
  handleHandshakeTimeout,
  initiateHandshake,
  isPeerValidated,
  isHandshakeRequired,
  queueMessageForPeer,
  removePeerValidation,
  deserializeMessage,
  serializeMessage,
} from '../transport/message-bridge';
import { isHandshakeMessage } from '../protocol/handshake';
import { ECCO_MAINNET, DEFAULT_CONSTITUTION, type NetworkConfig } from '../networks';
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
  const version = formatProtocolVersion(SDK_PROTOCOL_VERSION);
  const baseProtocol = `/ecco/kad/${version}`;
  if (networkId) {
    return `${baseProtocol}/${networkId}`;
  }
  return baseProtocol;
}

function buildNetworkConfig(config: NodeState['config']): NetworkConfig {
  return {
    networkId: config.networkId ?? ECCO_MAINNET.networkId,
    discovery: config.discovery,
    bootstrap: {
      enabled: config.bootstrap?.enabled ?? false,
      peers: config.bootstrap?.peers ?? [],
      timeout: config.bootstrap?.timeout ?? 30000,
      minPeers: config.bootstrap?.minPeers ?? 1,
    },
    protocol: config.protocol ?? ECCO_MAINNET.protocol,
    constitution: config.constitution ?? DEFAULT_CONSTITUTION,
  };
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
    connectionEncrypters: [noise({ crypto: pureJsCrypto })],
    streamMuxers: [yamux()],
    peerDiscovery: peerDiscoveryList,
    services: servicesConfig,
    connectionManager: {
      maxConnections: 100,
      inboundConnectionThreshold: 50,
    },
    ...(state.libp2pPrivateKey && { privateKey: state.libp2pPrivateKey }),
  };

  const node = await createLibp2p<EccoServices>(libp2pOptions);
  await node.start();
  updateState(stateRef, (s) => ({
    ...setNode(s, node),
    libp2pPeerId: node.peerId.toString(),
  }));
}

async function setupAuthentication(stateRef: StateRef<NodeState>): Promise<void> {
  const state = getState(stateRef);

  if (!(state.config.authentication?.enabled ?? false)) {
    return;
  }

  const identity = await loadOrCreateNodeIdentity(state.config);

  const authState: AuthState = {
    config: {
      enabled: true,
      privateKey: identity.libp2pPrivateKey,
    },
    keyCache: createPublicKeyCache(),
  };
  updateState(stateRef, (s) => ({
    ...setMessageAuth(s, authState),
    libp2pPrivateKey: identity.libp2pPrivateKey,
    id: state.config.nodeId ?? identity.peerId,
  }));

  const walletRpcUrls = state.config.authentication?.walletRpcUrls;
  const hasWalletRpcUrls = walletRpcUrls && Object.keys(walletRpcUrls).length > 0;

  if (hasWalletRpcUrls) {
    const walletState = createWalletState({
      privateKey: identity.ethereumPrivateKey,
      chains: [],
      rpcUrls: walletRpcUrls,
    });
    updateState(stateRef, (s) => setWallet(s, walletState));
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
  const hasProximityConfig = state.config.proximity?.bluetooth?.enabled;

  const shouldSetupTransport = hasGossipEnabled ||
                               hasProximityConfig ||
                               state.config.discovery.includes('bluetooth');

  if (!shouldSetupTransport) {
    return;
  }

  const networkConfig = buildNetworkConfig(state.config);

  let messageBridge = createMessageBridge({
    nodeId: state.id,
    authEnabled: state.config.authentication?.enabled ?? false,
    networkConfig,
  });

  if (state.messageAuth) {
    messageBridge = setMessageBridgeAuth(messageBridge, state.messageAuth);
  }

  messageBridge = setHandshakeCallbacks(messageBridge, {
    onPeerValidated: (peerId: string) => {
      debug('handshake', `Peer ${peerId} validated`);
    },
    onPeerRejected: (peerId: string, reason: string) => {
      debug('handshake', `Peer ${peerId} rejected: ${reason}`);
    },
    onUpgradeRequired: (peerId: string, requiredVersion: string, upgradeUrl?: string) => {
      console.warn(`[ecco] Peer ${peerId} requires protocol upgrade to ${requiredVersion}. ${upgradeUrl ? `Upgrade at: ${upgradeUrl}` : ''}`);
    },
    onConstitutionMismatch: (peerId: string, expectedHash: string, receivedHash: string) => {
      console.warn(`[ecco] Constitution mismatch with peer ${peerId}. Expected: ${expectedHash}, received: ${receivedHash}`);
    },
    onHandshakeTimeout: (peerId: string) => {
      updateState(stateRef, (s) => {
        if (!s.messageBridge) {
          return s;
        }
        const updatedBridge = handleHandshakeTimeout(s.messageBridge, peerId);
        return setMessageBridge(s, updatedBridge);
      });
    },
    sendMessage: async (peerId: string, message: Message) => {
      const currentState = getState(stateRef);
      if (!currentState.transport || !currentState.messageBridge) return;

      const transportMessage = await serializeMessage(currentState.messageBridge, message);

      for (const adapter of currentState.transport.adapters.values()) {
        if (adapter.state === 'connected') {
          try {
            await adapter.send(peerId, transportMessage);
            return;
          } catch {
            continue;
          }
        }
      }
    },
    disconnectPeer: async (peerId: string) => {
      const currentState = getState(stateRef);
      if (currentState.node) {
        const connections = currentState.node.getConnections().filter(
          conn => conn.remotePeer.toString().toLowerCase() === peerId.toLowerCase()
        );
        for (const conn of connections) {
          await conn.close();
        }
      }
      if (currentState.messageBridge) {
        const updatedBridge = removePeerValidation(currentState.messageBridge, peerId);
        updateState(stateRef, (s) => setMessageBridge(s, updatedBridge));
      }
    },
  });

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
    bleAdapterState = await initBLEAdapter(bleAdapterState);
    hybridDiscovery = registerHybridAdapter(hybridDiscovery, toBLEAdapter(bleAdapterState));
  }

  hybridDiscovery = await startHybridDiscovery(hybridDiscovery);

  onHybridMessage(hybridDiscovery, async (peerId, transportMessage) => {
    const currentState = getState(stateRef);
    if (currentState.shuttingDown) {
      return;
    }
    if (peerId.toLowerCase() === currentState.libp2pPeerId?.toLowerCase() || peerId.toLowerCase() === currentState.id.toLowerCase()) {
      return;
    }
    if (!currentState.messageBridge) {
      return;
    }

    const { message, valid, updatedState: deserializedState } = await deserializeMessage(
      currentState.messageBridge,
      {
        id: '',
        from: peerId,
        to: currentState.id,
        data: transportMessage.data,
        timestamp: Date.now()
      }
    );

    if (!valid || !message) {
      return;
    }

    let bridge = deserializedState;

    if (isHandshakeMessage(message)) {
      switch (message.type) {
        case 'version-handshake':
          bridge = await handleVersionHandshake(bridge, peerId, message);
          break;
        case 'version-handshake-response':
          bridge = await handleVersionHandshakeResponse(bridge, peerId, message);
          break;
        case 'version-incompatible-notice':
          bridge = handleVersionIncompatibleNotice(bridge, peerId, message);
          break;
        case 'constitution-mismatch-notice':
          bridge = handleConstitutionMismatchNotice(bridge, peerId, message);
          break;
      }
      updateState(stateRef, (s) => setMessageBridge(s, bridge));
      return;
    }

    if (isHandshakeRequired(bridge) && !isPeerValidated(bridge, peerId)) {
      debug('handshake', `Message from unvalidated peer ${peerId}, queueing`);
      bridge = queueMessageForPeer(bridge, peerId, message);
      bridge = await initiateHandshake(bridge, peerId);
      updateState(stateRef, (s) => setMessageBridge(s, bridge));
      return;
    }

    const updatedBridge = await handleIncomingBroadcast(
      bridge,
      peerId,
      transportMessage
    );
    updateState(stateRef, (s) => setMessageBridge(s, updatedBridge));
  });

  updateState(stateRef, (s) => setTransport(s, hybridDiscovery));
}

export async function start(state: NodeState): Promise<StateRef<NodeState>> {
  const stateRef = createStateRef(state);

  await initializeStorage(stateRef);
  await setupAuthentication(stateRef);
  await createLibp2pNode(stateRef);
  await setupTransport(stateRef);
  setupEventListeners(getState(stateRef), stateRef);
  setupCapabilityTracking(stateRef);
  await setupBootstrap(stateRef);
  await announceCapabilities(getState(stateRef));

  return stateRef;
}

export async function stop(stateRef: StateRef<NodeState>): Promise<void> {
  updateState(stateRef, (s) => ({ ...s, shuttingDown: true }));

  const state = getState(stateRef);

  await runCleanupHandlers(state);

  updateState(stateRef, (s) => ({
    ...s,
    subscriptions: {},
    subscribedTopics: new Map(),
  }));

  if (state.transport) {
    await stopHybridDiscovery(state.transport);
  }

  if (state.connectionPool) {
    await closePool(state.connectionPool);
  }

  if (state.node) {
    await withTimeout(Promise.resolve(state.node.stop()), 5000, 'Libp2p node stop timeout').catch(() => {});
  }
}

export async function sendMessage(
  stateRef: StateRef<NodeState>,
  peerId: string,
  message: Message
): Promise<void> {
  const state = getState(stateRef);

  if (state.shuttingDown) {
    return;
  }

  debug('sendMessage', `Sending message to ${peerId}, hasMessageBridge=${!!state.messageBridge}, hasTransport=${!!state.transport}`);

  const maxAttempts = state.config.retry?.maxAttempts || 3;
  const initialDelay = state.config.retry?.initialDelay || 1000;
  const maxDelay = state.config.retry?.maxDelay || 10000;

  try {
    await retryWithBackoff(
      async () => {
        const currentState = getState(stateRef);

        if (currentState.shuttingDown) {
          return;
        }

        if (currentState.messageBridge && currentState.transport) {
          debug('sendMessage', 'Using publishDirect path');
          const { publishDirect } = await import('./messaging');
          await publishDirect(currentState, peerId, message);
          debug('sendMessage', 'publishDirect completed');
          return;
        }
        debug('sendMessage', 'Using pubsub path');
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
        debug('sendMessage', 'pubsub publish completed');
      },
      {
        maxAttempts,
        initialDelay,
        maxDelay,
      }
    );
  } catch (error) {
    const currentState = getState(stateRef);
    if (currentState.shuttingDown) {
      return;
    }
    throw error;
  }
}
