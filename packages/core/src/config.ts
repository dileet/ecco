import type { EccoConfig } from './types';
import { ECCO_MAINNET, type NetworkName, type NetworkConfig, applyNetworkConfig } from './networks';

export const configDefaults: EccoConfig = {
  discovery: ECCO_MAINNET.discovery,
  authentication: { enabled: false },
  networkId: ECCO_MAINNET.networkId,
  bootstrap: ECCO_MAINNET.bootstrap,
  protocol: ECCO_MAINNET.protocol,
  constitution: ECCO_MAINNET.constitution,
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
