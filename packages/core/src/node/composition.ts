import { Effect, Ref, Schedule, Duration } from 'effect';
import { Auth } from '../auth';
import { RegistryService, WalletService, WalletServiceLive } from '../services';
import { setupEventListeners } from './discovery';
import { announceCapabilities } from './capabilities';
import { connectToBootstrapPeers } from './bootstrap';
import { setMessageAuthRef, getState, setRegistryClientRef, setWalletRef, updateState } from './state-ref';
import { loadOrCreateNodeIdentity } from './identity';
import { withTimeoutEffect } from '../util/timeout';
import type { NodeState } from './types';
import type {
  AuthError,
  ConnectError,
  RegistryErrorType,
  CapabilityErrorType,
  WalletError
} from '../errors';
import { ConnectionError, RegistryConnectionError } from '../errors';

export const withAuthentication = (stateRef: Ref.Ref<NodeState>): Effect.Effect<void, AuthError | WalletError> =>
  Effect.gen(function* () {
    const state = yield* getState(stateRef);

    if (state.config.authentication?.enabled ?? false) {
      const identity = yield* Effect.promise(() => loadOrCreateNodeIdentity(state.config));
      console.log(`Message authentication enabled (${identity.created ? 'generated new keys' : 'loaded keys'})`);

      yield* setMessageAuthRef(stateRef, Auth.create({
        enabled: true,
        privateKey: identity.privateKey,
        publicKey: identity.publicKey,
      }));

      if (!state.config.nodeId) {
        yield* updateState(stateRef, (current) => ({
          ...current,
          id: identity.nodeIdFromKeys
        }));
      }

      if (state.config.authentication?.walletAutoInit && identity.ethereumPrivateKey) {
        const walletService = yield* WalletService;
        const walletStateRef = yield* walletService.createState({
          privateKey: identity.ethereumPrivateKey,
          chains: [],
          rpcUrls: state.config.authentication.walletRpcUrls,
        });
        yield* setWalletRef(stateRef, walletStateRef);
        console.log('Wallet initialized with authentication keys');
      }
    }
  }).pipe(Effect.provide(WalletServiceLive));

export const withDiscovery = (_stateRef: Ref.Ref<NodeState>): Effect.Effect<void, never> =>
  Effect.void;

export const withDHT = (stateRef: Ref.Ref<NodeState>): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const state = yield* getState(stateRef);

    if (state.config.discovery.includes('dht') && state.node?.services.dht) {
      console.log('[DHT] Initializing DHT...');
    }
  });

export const withMessaging = (_stateRef: Ref.Ref<NodeState>): Effect.Effect<void, never> =>
  Effect.void;

export const withEventListeners = (stateRef: Ref.Ref<NodeState>): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const state = yield* getState(stateRef);
    yield* Effect.sync(() => setupEventListeners(state, stateRef));
  });

export const withBootstrap = (stateRef: Ref.Ref<NodeState>): Effect.Effect<void, ConnectError> =>
  Effect.gen(function* () {
    const state = yield* getState(stateRef);

    const shouldBootstrap = state.config.bootstrap?.enabled &&
                           state.config.bootstrap.peers &&
                           state.config.bootstrap.peers.length > 0;

    if (shouldBootstrap) {
      yield* connectToBootstrapPeers(state).pipe(
        Effect.mapError((error) => new ConnectionError({
          message: error.message,
          peerId: error.peerId || 'bootstrap',
          cause: error,
        })),
        Effect.asVoid
      );
    }
  });

export const withRegistry = (stateRef: Ref.Ref<NodeState>): Effect.Effect<void, RegistryErrorType> =>
  Effect.gen(function* () {
    const state = yield* getState(stateRef);

    if (state.config.registry) {
      const registryService = yield* RegistryService;
      const registryClientRef = yield* registryService.createState({
        url: state.config.registry,
        reconnect: true,
        reconnectInterval: 5000,
        timeout: 10000,
      });

      const connectWithRetry = withTimeoutEffect(
        registryService.connect(registryClientRef),
        10000,
        'Registry connection timeout'
      ).pipe(
        Effect.retry({
          schedule: Schedule.exponential(Duration.millis(2000)).pipe(
            Schedule.intersect(Schedule.recurs(2)),
            Schedule.union(Schedule.spaced(Duration.millis(10000)))
          ),
          while: (error) => {
            if (error instanceof RegistryConnectionError || error.message?.includes('timeout')) {
              return true;
            }
            return false;
          },
        }),
        Effect.tapError((error) =>
          Effect.sync(() => {
            console.warn(`Registry connection attempt failed: ${error.message}`);
          })
        )
      );

      yield* connectWithRetry.pipe(
        Effect.catchAll((error) => {
          if (state.config.fallbackToP2P) {
            console.log('Failed to connect to registry, falling back to P2P discovery only');
            return Effect.succeed(void 0);
          }
          return Effect.fail(error);
        })
      );

      const isConnected = yield* registryService.isConnected(registryClientRef);
      if (isConnected) {
        yield* setRegistryClientRef(stateRef, registryClientRef);
        
        const updatedState = yield* getState(stateRef);
        if (updatedState.node) {
          const addresses = updatedState.node.getMultiaddrs().map(String);
          yield* registryService.register(
            registryClientRef,
            updatedState.id,
            updatedState.capabilities,
            addresses
          );
        }
      }
    }
  });

export const withCapabilities = (stateRef: Ref.Ref<NodeState>): Effect.Effect<void, CapabilityErrorType> =>
  Effect.gen(function* () {
    const state = yield* getState(stateRef);
    yield* Effect.promise(() => announceCapabilities(state));
  });

export const withResilience = (_stateRef: Ref.Ref<NodeState>): Effect.Effect<void, never> =>
  Effect.void;
