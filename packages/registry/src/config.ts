import { Config as EffectConfig, Effect, ConfigError, Redacted, Option } from 'effect';
import type { RegistryConfig } from './types';

const redisConfig = EffectConfig.all({
  host: EffectConfig.string('REDIS_HOST').pipe(
    EffectConfig.withDefault('localhost')
  ),
  port: EffectConfig.integer('REDIS_PORT').pipe(
    EffectConfig.withDefault(6379)
  ),
  password: EffectConfig.redacted('REDIS_PASSWORD').pipe(
    EffectConfig.option
  ),
  db: EffectConfig.integer('REDIS_DB').pipe(
    EffectConfig.withDefault(0),
    EffectConfig.option
  )
});

const postgresConfig = EffectConfig.all({
  host: EffectConfig.string('POSTGRES_HOST').pipe(
    EffectConfig.withDefault('localhost')
  ),
  port: EffectConfig.integer('POSTGRES_PORT').pipe(
    EffectConfig.withDefault(5432)
  ),
  database: EffectConfig.string('POSTGRES_DB').pipe(
    EffectConfig.withDefault('ecco_registry')
  ),
  user: EffectConfig.string('POSTGRES_USER').pipe(
    EffectConfig.withDefault('postgres')
  ),
  password: EffectConfig.redacted('POSTGRES_PASSWORD').pipe(
    EffectConfig.withDefault(Redacted.make('postgres'))
  )
});

const rateLimitConfig = EffectConfig.all({
  enabled: EffectConfig.boolean('RATE_LIMIT_ENABLED').pipe(
    EffectConfig.withDefault(true)
  ),
  maxRequests: EffectConfig.integer('RATE_LIMIT_MAX_REQUESTS').pipe(
    EffectConfig.withDefault(100)
  ),
  windowMs: EffectConfig.integer('RATE_LIMIT_WINDOW_MS').pipe(
    EffectConfig.withDefault(60000)
  )
});

export const registryConfig = EffectConfig.all({
  httpPort: EffectConfig.integer('HTTP_PORT').pipe(
    EffectConfig.withDefault(8081)
  ),
  redis: redisConfig,
  postgres: postgresConfig,
  rateLimit: rateLimitConfig,
  nodeTimeout: EffectConfig.integer('NODE_TIMEOUT_MS').pipe(
    EffectConfig.withDefault(60000)
  ),
  cleanupInterval: EffectConfig.integer('CLEANUP_INTERVAL_MS').pipe(
    EffectConfig.withDefault(60000)
  )
});

export namespace Config {
  export const load = (): Effect.Effect<RegistryConfig, ConfigError.ConfigError> =>
    Effect.gen(function* () {
      const raw = yield* registryConfig;

      return {
        httpPort: raw.httpPort,
        redis: {
          host: raw.redis.host,
          port: raw.redis.port,
          password: Option.map(raw.redis.password, Redacted.value).pipe(Option.getOrUndefined),
          db: Option.getOrUndefined(raw.redis.db),
        },
        postgres: {
          host: raw.postgres.host,
          port: raw.postgres.port,
          database: raw.postgres.database,
          user: raw.postgres.user,
          password: Redacted.value(raw.postgres.password),
        },
        rateLimit: raw.rateLimit,
        nodeTimeout: raw.nodeTimeout,
        cleanupInterval: raw.cleanupInterval,
      };
    });

  export const getPostgresConnectionString = (
    config: RegistryConfig
  ): string => {
    return `postgres://${config.postgres.user}:${config.postgres.password}@${config.postgres.host}:${config.postgres.port}/${config.postgres.database}`;
  };
}

export function loadConfig(): RegistryConfig {
  return Effect.runSync(Config.load());
}

export function getPostgresConnectionString(config: RegistryConfig): string {
  return Config.getPostgresConnectionString(config);
}
