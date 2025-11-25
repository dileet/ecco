import type { EccoConfig } from './types';

export const configDefaults: EccoConfig = {
  discovery: ['mdns', 'gossip'],
  fallbackToP2P: true,
  authentication: { enabled: false },
};

export function mergeConfig(base: EccoConfig, overrides: Partial<EccoConfig>): EccoConfig {
  return { ...base, ...overrides };
}
