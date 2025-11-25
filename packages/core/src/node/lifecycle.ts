import { Effect, Ref } from 'effect';
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
import { executeWithBreaker, DEFAULT_BREAKER_CONFIG, INITIAL_BREAKER_STATE } from '../util/circuit-breaker';
import { Matcher } from '../orchestrator/capability-matcher';
import {
  connect as connectRegistry,
  disconnect as disconnectRegistry,
  register as registerWithRegistry,
  unregister as unregisterFromRegistry,
  query as queryRegistryClient,
  type ClientState as RegistryClientState,
} from '../registry-client';
import { StorageService, StorageServiceLive } from '../storage';
import { Pool, type PoolState } from '../connection';
import { withRetry } from '../util/retry';
import { publish } from './messaging';
import type { Capability } from '../types';
import type { ConnectionPoolConfig } from '../connection/types';
import {
  makeStateRef,
  getState,
  setNodeRef,
  addPeersRef,
  setCircuitBreakerRef,
  getOrCreateCircuitBreaker,
  updateState,
} from './state-ref';
import type { MessageEvent } from '../events';
import {
  withAuthentication,
  withDiscovery,
  withDHT,
  withMessaging,
  withEventListeners,
  withBootstrap,
  withRegistry,
  withCapabilities,
  withResilience,
} from './composition';
import type { NodeState, EccoServices } from './types';
import type { CapabilityQuery, CapabilityMatch, Message, PeerInfo } from '../types';
import type { RegistryQueryError } from '../errors';
import {
  LibP2PInitError,
  RegistryConnectionError,
  RegistryRegistrationError,
  type AuthError,
  type ConnectError,
  type RegistryErrorType,
  type CapabilityErrorType
} from '../errors';

const createLibp2pNode = (stateRef: Ref.Ref<NodeState>): Effect.Effect<void, LibP2PInitError> =>
  Effect.gen(function* () {
    const state = yield* getState(stateRef);

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

    const node = yield* Effect.promise(() =>
      createLibp2p<EccoServices>(libp2pOptions)
    );

    yield* Effect.promise(async () => { await node.start(); });
    console.log(`Ecco node started: ${state.id}`);
    console.log(`Listening on:`, node.getMultiaddrs().map(String));

    yield* setNodeRef(stateRef, node);
  });

export type NodeCreationError =
  | AuthError
  | LibP2PInitError
  | ConnectError
  | RegistryErrorType
  | CapabilityErrorType;

export const createNode = (
  state: NodeState
): Effect.Effect<Ref.Ref<NodeState>, NodeCreationError, StorageService> =>
  Effect.gen(function* () {
    const stateRef = yield* makeStateRef(state);

    const storageService = yield* StorageService;
    yield* storageService.initialize(state.id);

    const escrowAgreements = yield* storageService.loadEscrowAgreements();
    const paymentLedger = yield* storageService.loadPaymentLedger();
    const streamingChannels = yield* storageService.loadStreamingChannels();
    const stakePositions = yield* storageService.loadStakePositions();
    const swarmSplits = yield* storageService.loadSwarmSplits();
    const pendingSettlements = yield* storageService.loadPendingSettlements();

    yield* updateState(stateRef, (currentState) => ({
      ...currentState,
      escrowAgreements,
      paymentLedger,
      streamingChannels,
      stakePositions,
      swarmSplits,
      pendingSettlements,
    }));

    yield* withAuthentication(stateRef);
    yield* withDiscovery(stateRef);
    yield* createLibp2pNode(stateRef);
    yield* withEventListeners(stateRef);
    yield* withBootstrap(stateRef);
    yield* withDHT(stateRef);
    yield* withMessaging(stateRef);
    yield* withRegistry(stateRef);
    yield* withCapabilities(stateRef);
    yield* withResilience(stateRef);

    return stateRef;
  });

export async function start(
  state: NodeState
): Promise<Ref.Ref<NodeState>> {
  const program = createNode(state).pipe(
    Effect.provide(StorageServiceLive)
  );
  return Effect.runPromise(program);
}

export async function stop(stateRef: Ref.Ref<NodeState>): Promise<void> {
  const state = await Effect.runPromise(getState(stateRef));

  if (state.registryClientRef) {
    const registryState = await Effect.runPromise(Ref.get(state.registryClientRef));
    await unregisterFromRegistry(registryState);
    await disconnectRegistry(registryState);
  }

  if (state.connectionPool) {
    await Pool.close(state.connectionPool);
  }

  if (state.node) {
    await state.node.stop();
    console.log('Ecco node stopped');
  }
}

export namespace Resources {
  export function makeLibp2pNode(
    config: Libp2pOptions
  ): Effect.Effect<unknown, LibP2PInitError, import('effect/Scope').Scope> {
    return Effect.acquireRelease(
      Effect.gen(function* () {
        const node = yield* Effect.tryPromise({
          try: () => createLibp2p(config),
          catch: (error) => new LibP2PInitError({
            message: `Failed to create libp2p node: ${error instanceof Error ? error.message : 'Unknown error'}`,
            cause: error,
          }),
        });

        yield* Effect.tryPromise({
          try: async () => { await node.start(); },
          catch: (error) => new LibP2PInitError({
            message: `Failed to start libp2p node: ${error instanceof Error ? error.message : 'Unknown error'}`,
            cause: error,
          }),
        });

        console.log(`Libp2p node started`);
        return node;
      }),
      (node) => Effect.tryPromise(() => Promise.resolve(node.stop())).pipe(
        Effect.tap(() => Effect.sync(() => console.log('Libp2p node stopped'))),
        Effect.catchAll((error) => {
          console.error('Error stopping libp2p node:', error);
          return Effect.succeed(void 0);
        })
      )
    );
  }

  export function makeRegistryClient(
    config: string,
    nodeId?: string,
    capabilities?: Capability[],
    addresses?: string[]
  ): Effect.Effect<Ref.Ref<RegistryClientState>, RegistryErrorType, import('effect/Scope').Scope> {
    return Effect.acquireRelease(
      Effect.gen(function* () {
        let clientState = yield* Effect.promise(() => connectRegistry({ url: config }));

        if (nodeId && capabilities && addresses) {
          clientState = yield* Effect.promise(() => registerWithRegistry(clientState, nodeId, capabilities, addresses));
        }

        return yield* Ref.make(clientState);
      }),
      (registryClientRef) =>
        Effect.gen(function* () {
          const clientState = yield* Ref.get(registryClientRef);
          yield* Effect.promise(() => unregisterFromRegistry(clientState));
          yield* Effect.promise(() => disconnectRegistry(clientState));
          console.log('Registry client disconnected');
        }).pipe(
          Effect.catchAll((error) => {
            console.error('Error disconnecting from registry:', error);
            return Effect.succeed(void 0);
          })
        )
    );
  }

  export function makeConnectionPool(
    config?: Partial<ConnectionPoolConfig>
  ): Effect.Effect<PoolState, never, import('effect/Scope').Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => Pool.createState(config)),
      (pool) => Effect.tryPromise(() => Pool.close(pool)).pipe(
        Effect.tap(() => Effect.sync(() => console.log('Connection pool closed'))),
        Effect.catchAll((error) => {
          console.error('Error closing connection pool:', error);
          return Effect.succeed(void 0);
        })
      )
    );
  }

  export function withScoped<A, E, R>(
    program: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, Exclude<R, import('effect/Scope').Scope>> {
    return Effect.scoped(program);
  }
}

// Pure business logic namespace
namespace PeerDiscoveryLogic {
  export type DiscoveryStrategy = 'local' | 'registry' | 'dht' | 'gossip';

  export function selectDiscoveryStrategy(
    localMatches: CapabilityMatch[],
    config: NodeState['config'],
    hasRegistry: boolean,
    hasDHT: boolean
  ): DiscoveryStrategy[] {
    // If we have local matches, use them
    if (localMatches.length > 0) {
      return ['local'];
    }

    const strategies: DiscoveryStrategy[] = [];

    // Try registry first (centralized, fastest)
    if (hasRegistry) {
      strategies.push('registry');
    }

    // Then DHT (decentralized discovery)
    if (config.discovery.includes('dht') && hasDHT) {
      strategies.push('dht');
    }

    // Finally gossip (broadcast, slowest but most resilient)
    if (config.discovery.includes('gossip')) {
      strategies.push('gossip');
    }

    return strategies;
  }

  export function mergePeers(
    existingPeers: Map<string, PeerInfo>,
    newPeers: PeerInfo[]
  ): PeerInfo[] {
    return newPeers.filter(peer => !existingPeers.has(peer.id));
  }
}

namespace PeerDiscoveryEffects {
  export function queryRegistry(
    registryClientRef: Ref.Ref<RegistryClientState>,
    query: CapabilityQuery
  ): Effect.Effect<PeerInfo[], RegistryQueryError> {
    console.log('No local matches, querying registry...');
    return Effect.gen(function* () {
      const clientState = yield* Ref.get(registryClientRef);
      return yield* Effect.promise(() => queryRegistryClient(clientState, query));
    }).pipe(
      Effect.catchAll((error) => {
        console.error('Registry query failed:', error);
        return Effect.succeed([]);
      })
    );
  }

  export async function dialRegistryPeers(
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
        } catch (error) {
          continue;
        }
      }
    }
  }

  export async function queryGossip(
    stateRef: Ref.Ref<NodeState>,
    query: CapabilityQuery
  ): Promise<CapabilityMatch[]> {
    console.log('No local matches, broadcasting capability request...');
    const { requestCapabilities } = await import('./capabilities');
    return await Effect.runPromise(requestCapabilities(stateRef, query));
  }
}

export async function findPeers(
  stateRef: Ref.Ref<NodeState>,
  query: CapabilityQuery
): Promise<CapabilityMatch[]> {
  const program = Effect.gen(function* () {
    let state = yield* getState(stateRef);
    const peerList = Array.from(state.peers.values());
    let matches = Matcher.matchPeers(state.capabilityMatcher, peerList, query);

    const isRegistryConnected = state.registryClientRef
      ? yield* Effect.promise(async () => {
          const clientState = await Effect.runPromise(Ref.get(state.registryClientRef!));
          return clientState.connected;
        })
      : false;

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
          const gossipMatches = yield* Effect.promise(() =>
            PeerDiscoveryEffects.queryGossip(stateRef, query)
          );
          if (gossipMatches.length > 0) {
            const existingMatchIds = new Set(matches.map(m => m.peer.id));
            const newMatches = gossipMatches.filter(m => !existingMatchIds.has(m.peer.id));
            matches = [...matches, ...newMatches];
          }
        }
        return matches;
      }

      if (strategy === 'registry' && state.registryClientRef) {
        const registryPeers = yield* PeerDiscoveryEffects.queryRegistry(
          state.registryClientRef,
          query
        );
        const newPeers = PeerDiscoveryLogic.mergePeers(state.peers, registryPeers);

        yield* addPeersRef(stateRef, newPeers);

        if (state.node && newPeers.length > 0) {
          yield* Effect.promise(() =>
            PeerDiscoveryEffects.dialRegistryPeers(state.node!, newPeers)
          );
        }

        state = yield* getState(stateRef);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 2000)));

        state = yield* getState(stateRef);
        const updatedPeerList = Array.from(state.peers.values());
        matches = Matcher.matchPeers(state.capabilityMatcher, updatedPeerList, query);
        if (matches.length > 0) {
          return matches;
        }
      }

      if (strategy === 'dht' && state.node?.services.dht) {
        console.log('No matches from registry, querying DHT...');
        const dhtPeers = yield* Effect.promise(async () => {
          const currentNode = state.node;
          if (!currentNode) {
            throw new Error('Node not initialized');
          }
          const { DHT } = await import('./dht');
          return DHT.queryCapabilities(currentNode, query, state.capabilityMatcher);
        });
        const newPeers = PeerDiscoveryLogic.mergePeers(state.peers, dhtPeers);

        yield* addPeersRef(stateRef, newPeers);

        state = yield* getState(stateRef);
        const updatedPeerList = Array.from(state.peers.values());
        matches = Matcher.matchPeers(state.capabilityMatcher, updatedPeerList, query);
        if (matches.length > 0) {
          return matches;
        }
      }

      if (strategy === 'gossip') {
        matches = yield* Effect.promise(() =>
          PeerDiscoveryEffects.queryGossip(stateRef, query)
        );
        if (matches.length > 0) {
          return matches;
        }
      }
    }

    return matches;
  });

  return Effect.runPromise(program);
}

export async function sendMessage(
  stateRef: Ref.Ref<NodeState>,
  peerId: string,
  message: Message
): Promise<void> {
  const program = Effect.gen(function* () {
    const breaker = yield* getOrCreateCircuitBreaker(
      stateRef,
      peerId,
      () => ({
        ...INITIAL_BREAKER_STATE,
        config: { ...DEFAULT_BREAKER_CONFIG, failureThreshold: 5, resetTimeout: 60000, halfOpenRequests: 3 },
      })
    );

    const state = yield* getState(stateRef);

    const { breaker: newBreaker } = yield* Effect.promise(() =>
      executeWithBreaker(breaker, async () => {
        await withRetry(
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

            if (state.connectionPool) {
              await sendMessageWithPool(state, peerId, messageEvent);
            } else {
              await publish(state, `peer:${peerId}`, messageEvent);
            }
          },
          {
            maxAttempts: state.config.retry?.maxAttempts || 3,
            initialDelay: state.config.retry?.initialDelay || 1000,
            maxDelay: state.config.retry?.maxDelay || 10000,
          },
          (attempt, error) => {
            console.warn(
              `Retry ${attempt} for message to ${peerId}: ${error.message}`
            );
          }
        );
      })
    );

    yield* setCircuitBreakerRef(stateRef, peerId, newBreaker);
  });

  return Effect.runPromise(program);
}

async function sendMessageWithPool(state: NodeState, peerId: string, messageEvent: MessageEvent): Promise<void> {
  if (!state.connectionPool) {
    throw new Error('Connection pool not initialized');
  }

  await publish(state, `peer:${peerId}`, messageEvent);
}

