import { Config as EffectConfig, Effect, ConfigError, ConfigProvider, Either, Option } from 'effect';
import type { EccoConfig, DiscoveryMethod, Capability } from './types';

const discoveryMethodConfig = EffectConfig.string('ECCO_DISCOVERY_METHOD').pipe(
  EffectConfig.mapOrFail((value: string) => {
    const methods = value.split(',').map((m: string) => m.trim()) as DiscoveryMethod[];
    const validMethods: DiscoveryMethod[] = ['mdns', 'dht', 'gossip', 'registry'];

    for (const method of methods) {
      if (!validMethods.includes(method)) {
        return Either.left(ConfigError.InvalidData([], `Invalid discovery method: ${method}. Valid: ${validMethods.join(', ')}`));
      }
    }

    return Either.right(methods);
  }),
  EffectConfig.withDefault(['mdns', 'gossip'] as DiscoveryMethod[])
);

const capabilityConfig = EffectConfig.string('ECCO_CAPABILITIES').pipe(
  EffectConfig.mapOrFail((value: string) => {
    try {
      const parsed = JSON.parse(value) as Capability[];
      return Either.right(parsed);
    } catch (e) {
      return Either.left(ConfigError.InvalidData([], `Invalid capabilities JSON: ${e}`));
    }
  }),
  EffectConfig.option
);

const transportConfig = EffectConfig.all({
  websocket: EffectConfig.all({
    enabled: EffectConfig.boolean('ECCO_TRANSPORT_WEBSOCKET_ENABLED').pipe(
      EffectConfig.withDefault(true)
    ),
    port: EffectConfig.integer('ECCO_TRANSPORT_WEBSOCKET_PORT').pipe(
      EffectConfig.option
    )
  }).pipe(EffectConfig.option),
  webrtc: EffectConfig.all({
    enabled: EffectConfig.boolean('ECCO_TRANSPORT_WEBRTC_ENABLED').pipe(
      EffectConfig.withDefault(false)
    )
  }).pipe(EffectConfig.option)
}).pipe(EffectConfig.option);

const bootstrapConfig = EffectConfig.all({
  enabled: EffectConfig.boolean('ECCO_BOOTSTRAP_ENABLED').pipe(
    EffectConfig.withDefault(false)
  ),
  peers: EffectConfig.string('ECCO_BOOTSTRAP_PEERS').pipe(
    EffectConfig.map((value: string) => value.split(',').map((p: string) => p.trim())),
    EffectConfig.option
  ),
  timeout: EffectConfig.integer('ECCO_BOOTSTRAP_TIMEOUT_MS').pipe(
    EffectConfig.withDefault(30000),
    EffectConfig.option
  ),
  minPeers: EffectConfig.integer('ECCO_BOOTSTRAP_MIN_PEERS').pipe(
    EffectConfig.withDefault(1),
    EffectConfig.option
  )
}).pipe(EffectConfig.option);

const authenticationConfig = EffectConfig.all({
  enabled: EffectConfig.boolean('ECCO_AUTH_ENABLED').pipe(
    EffectConfig.withDefault(false)
  ),
  generateKeys: EffectConfig.boolean('ECCO_AUTH_GENERATE_KEYS').pipe(
    EffectConfig.withDefault(true),
    EffectConfig.option
  ),
  keyPath: EffectConfig.string('ECCO_AUTH_KEY_PATH').pipe(
    EffectConfig.option
  )
}).pipe(EffectConfig.option);

const retryConfig = EffectConfig.all({
  maxAttempts: EffectConfig.integer('ECCO_RETRY_MAX_ATTEMPTS').pipe(
    EffectConfig.withDefault(3),
    EffectConfig.option
  ),
  initialDelay: EffectConfig.integer('ECCO_RETRY_INITIAL_DELAY_MS').pipe(
    EffectConfig.withDefault(1000),
    EffectConfig.option
  ),
  maxDelay: EffectConfig.integer('ECCO_RETRY_MAX_DELAY_MS').pipe(
    EffectConfig.withDefault(10000),
    EffectConfig.option
  )
}).pipe(EffectConfig.option);

const connectionPoolConfig = EffectConfig.all({
  maxConnectionsPerPeer: EffectConfig.integer('ECCO_POOL_MAX_CONNECTIONS_PER_PEER').pipe(
    EffectConfig.withDefault(5),
    EffectConfig.option
  ),
  maxIdleTime: EffectConfig.integer('ECCO_POOL_MAX_IDLE_TIME_MS').pipe(
    EffectConfig.withDefault(60000),
    EffectConfig.option
  ),
  cleanupInterval: EffectConfig.integer('ECCO_POOL_CLEANUP_INTERVAL_MS').pipe(
    EffectConfig.withDefault(30000),
    EffectConfig.option
  )
}).pipe(EffectConfig.option);

export const eccoConfig = EffectConfig.all({
  discovery: discoveryMethodConfig,
  registry: EffectConfig.string('ECCO_REGISTRY_URL').pipe(EffectConfig.option),
  fallbackToP2P: EffectConfig.boolean('ECCO_FALLBACK_TO_P2P').pipe(
    EffectConfig.withDefault(true),
    EffectConfig.option
  ),
  nodeId: EffectConfig.string('ECCO_NODE_ID').pipe(EffectConfig.option),
  capabilities: capabilityConfig,
  transport: transportConfig,
  bootstrap: bootstrapConfig,
  authentication: authenticationConfig,
  retry: retryConfig,
  connectionPool: connectionPoolConfig
});

export namespace Config {
  export const defaults: EccoConfig = {
    discovery: ['mdns', 'gossip'],
    fallbackToP2P: true,
    authentication: { enabled: false },
  };

  export const load = (): Effect.Effect<EccoConfig, ConfigError.ConfigError> =>
    Effect.gen(function* () {
      const raw = yield* eccoConfig;

      return {
        discovery: raw.discovery,
        registry: Option.getOrUndefined(raw.registry),
        fallbackToP2P: Option.getOrUndefined(raw.fallbackToP2P),
        nodeId: Option.getOrUndefined(raw.nodeId),
        capabilities: Option.getOrUndefined(raw.capabilities),
        transport: Option.map(raw.transport, (t) => ({
          websocket: Option.map(t.websocket, (ws) => ({
            enabled: ws.enabled,
            port: Option.getOrUndefined(ws.port),
          })).pipe(Option.getOrUndefined),
          webrtc: Option.map(t.webrtc, (wr) => ({
            enabled: wr.enabled,
          })).pipe(Option.getOrUndefined),
        })).pipe(Option.getOrUndefined),
        bootstrap: Option.map(raw.bootstrap, (b) => ({
          enabled: b.enabled,
          peers: Option.getOrUndefined(b.peers),
          timeout: Option.getOrUndefined(b.timeout),
          minPeers: Option.getOrUndefined(b.minPeers),
        })).pipe(Option.getOrUndefined),
        authentication: Option.map(raw.authentication, (a) => ({
          enabled: a.enabled,
          generateKeys: Option.getOrUndefined(a.generateKeys),
          keyPath: Option.getOrUndefined(a.keyPath),
        })).pipe(Option.getOrUndefined),
        retry: Option.map(raw.retry, (r) => ({
          maxAttempts: Option.getOrUndefined(r.maxAttempts),
          initialDelay: Option.getOrUndefined(r.initialDelay),
          maxDelay: Option.getOrUndefined(r.maxDelay),
        })).pipe(Option.getOrUndefined),
        connectionPool: Option.map(raw.connectionPool, (cp) => ({
          maxConnectionsPerPeer: Option.getOrUndefined(cp.maxConnectionsPerPeer),
          maxIdleTime: Option.getOrUndefined(cp.maxIdleTime),
          cleanupInterval: Option.getOrUndefined(cp.cleanupInterval),
        })).pipe(Option.getOrUndefined),
      };
    });

  export const loadWith = (
    provider: ConfigProvider.ConfigProvider
  ): Effect.Effect<EccoConfig, ConfigError.ConfigError> =>
    load().pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider));

  export const loadWithDefaults = (): Effect.Effect<EccoConfig, ConfigError.ConfigError> =>
    Effect.gen(function* () {
      const config = yield* load();
      return { ...defaults, ...config };
    });

  export function merge(base: EccoConfig, overrides: Partial<EccoConfig>): EccoConfig {
    return { ...base, ...overrides };
  }
}
