import type { EccoConfig } from './types';
import { ECCO_TESTNET, type NetworkName, type NetworkConfig, applyNetworkConfig } from './networks';

export const configDefaults: EccoConfig = {
  discovery: ECCO_TESTNET.discovery,
  authentication: { enabled: false },
  networkId: ECCO_TESTNET.networkId,
  bootstrap: ECCO_TESTNET.bootstrap,
  protocol: ECCO_TESTNET.protocol,
  constitution: ECCO_TESTNET.constitution,
};

export function mergeConfig(base: EccoConfig, overrides: Partial<EccoConfig>): EccoConfig {
  return { ...base, ...overrides };
}

export function createConfig(
  overrides: Partial<EccoConfig> = {},
  network: NetworkName | NetworkConfig = 'testnet'
): EccoConfig {
  return applyNetworkConfig(overrides, network);
}
