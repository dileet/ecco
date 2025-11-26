import type { EccoConfig } from './types';
import { ECCO_MAINNET, type NetworkName, type NetworkConfig, applyNetworkConfig } from './networks';

export const configDefaults: EccoConfig = {
  discovery: ECCO_MAINNET.discovery,
  fallbackToP2P: true,
  authentication: { enabled: false },
  networkId: ECCO_MAINNET.networkId,
  bootstrap: ECCO_MAINNET.bootstrap,
};

export function mergeConfig(base: EccoConfig, overrides: Partial<EccoConfig>): EccoConfig {
  return { ...base, ...overrides };
}

export function createConfig(
  overrides: Partial<EccoConfig> = {},
  network: NetworkName | NetworkConfig = 'mainnet'
): EccoConfig {
  return applyNetworkConfig(overrides, network);
}
