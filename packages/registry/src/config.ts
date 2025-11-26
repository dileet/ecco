import type { RegistryConfig } from './types';

function getEnvString(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value === 'true' || value === '1';
}

export function loadConfig(): RegistryConfig {
  return {
    httpPort: getEnvInt('HTTP_PORT', 8081),
    redis: {
      host: getEnvString('REDIS_HOST', 'localhost'),
      port: getEnvInt('REDIS_PORT', 6379),
      password: process.env.REDIS_PASSWORD,
      db: process.env.REDIS_DB ? getEnvInt('REDIS_DB', 0) : undefined,
    },
    postgres: {
      host: getEnvString('POSTGRES_HOST', 'localhost'),
      port: getEnvInt('POSTGRES_PORT', 5432),
      database: getEnvString('POSTGRES_DB', 'ecco_registry'),
      user: getEnvString('POSTGRES_USER', 'postgres'),
      password: getEnvString('POSTGRES_PASSWORD', 'postgres'),
    },
    rateLimit: {
      enabled: getEnvBool('RATE_LIMIT_ENABLED', true),
      maxRequests: getEnvInt('RATE_LIMIT_MAX_REQUESTS', 100),
      windowMs: getEnvInt('RATE_LIMIT_WINDOW_MS', 60000),
    },
    nodeTimeout: getEnvInt('NODE_TIMEOUT_MS', 60000),
    cleanupInterval: getEnvInt('CLEANUP_INTERVAL_MS', 60000),
  };
}

export function getPostgresConnectionString(config: RegistryConfig): string {
  return `postgres://${config.postgres.user}:${config.postgres.password}@${config.postgres.host}:${config.postgres.port}/${config.postgres.database}`;
}
