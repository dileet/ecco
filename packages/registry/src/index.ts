/**
 * Registry exports for programmatic use
 */

export * as database from './database';
export * as cache from './cache';
export * as metrics from './metrics';
export { app } from './http-server';
export { loadConfig, getPostgresConnectionString } from './config';
export { logger } from './logger';

export type {
  RegistryConfig,
  Capability,
  NodeRegistration,
  CapabilityQuery,
  RegisteredNode,
  NodeMatch,
  ApiResponse,
  RegistryStats,
} from './types';
