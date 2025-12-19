import type { EccoConfig, DiscoveryMethod, ProtocolVersion, ProtocolConfig, Constitution } from './types';

export const SDK_PROTOCOL_VERSION: ProtocolVersion = {
  major: 1,
  minor: 0,
  patch: 0,
};

export function formatProtocolVersion(version: ProtocolVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export interface NetworkConfig {
  networkId: string;
  discovery: DiscoveryMethod[];
  bootstrap: {
    enabled: boolean;
    peers: string[];
    timeout: number;
    minPeers: number;
  };
  protocol: ProtocolConfig;
  constitution: Constitution;
}

export const OFFICIAL_BOOTSTRAP_PEERS: string[] = [
  // '/ip4/YOUR_SERVER_IP/tcp/4001/p2p/YOUR_PEER_ID',
  // '/dns4/bootstrap.yourdomain.com/tcp/4001/p2p/YOUR_PEER_ID',
];

const DEFAULT_DISCOVERY: DiscoveryMethod[] = ['mdns', 'dht', 'gossip'];

export const DEFAULT_CONSTITUTION: Constitution = {
  rules: [
    'Agents must provide honest and accurate responses to the best of their ability',
    'Agents must not intentionally disrupt network operations or corrupt shared data',
    'Agents must respect rate limits and not abuse network resources',
  ],
};

export const ECCO_MAINNET: NetworkConfig = {
  networkId: 'ecco-mainnet',
  discovery: DEFAULT_DISCOVERY,
  bootstrap: {
    enabled: OFFICIAL_BOOTSTRAP_PEERS.length > 0,
    peers: OFFICIAL_BOOTSTRAP_PEERS,
    timeout: 30000,
    minPeers: 1,
  },
  protocol: {
    currentVersion: SDK_PROTOCOL_VERSION,
    minVersion: { major: 1, minor: 0, patch: 0 },
    enforcementLevel: 'strict',
    upgradeUrl: 'https://github.com/dileet/ecco',
  },
  constitution: DEFAULT_CONSTITUTION,
};

export const ECCO_TESTNET: NetworkConfig = {
  networkId: 'ecco-testnet',
  discovery: DEFAULT_DISCOVERY,
  bootstrap: {
    enabled: false,
    peers: [],
    timeout: 30000,
    minPeers: 1,
  },
  protocol: {
    currentVersion: SDK_PROTOCOL_VERSION,
    minVersion: { major: 1, minor: 0, patch: 0 },
    enforcementLevel: 'warn',
  },
  constitution: DEFAULT_CONSTITUTION,
};

export function formatBootstrapPeer(host: string, port: number, peerId: string): string {
  if (host.match(/^\d+\.\d+\.\d+\.\d+$/)) {
    return `/ip4/${host}/tcp/${port}/p2p/${peerId}`;
  }
  return `/dns4/${host}/tcp/${port}/p2p/${peerId}`;
}

export function withBootstrapPeers(
  config: Partial<EccoConfig>,
  peers: string[]
): Partial<EccoConfig> {
  return {
    ...config,
    bootstrap: {
      enabled: peers.length > 0,
      peers,
      timeout: config.bootstrap?.timeout ?? 30000,
      minPeers: config.bootstrap?.minPeers ?? 1,
    },
  };
}

export const NETWORKS = {
  mainnet: ECCO_MAINNET,
  testnet: ECCO_TESTNET,
} as const;

export type NetworkName = keyof typeof NETWORKS;

export function getNetworkConfig(network: NetworkName): NetworkConfig {
  return NETWORKS[network];
}

export function applyNetworkConfig(
  baseConfig: Partial<EccoConfig>,
  network: NetworkName | NetworkConfig
): EccoConfig {
  const networkConfig = typeof network === 'string' ? NETWORKS[network] : network;

  return {
    discovery: networkConfig.discovery,
    authentication: { enabled: false },
    ...baseConfig,
    networkId: baseConfig.networkId ?? networkConfig.networkId,
    bootstrap: baseConfig.bootstrap ?? networkConfig.bootstrap,
  };
}

export const DEFAULT_NETWORK: NetworkName = 'mainnet';

export const MONAD_MAINNET_CHAIN_ID = 143;
export const MONAD_TESTNET_CHAIN_ID = 10143;

export const DEFAULT_CHAIN_IDS: Record<NetworkName, number> = {
  mainnet: MONAD_MAINNET_CHAIN_ID,
  testnet: MONAD_TESTNET_CHAIN_ID,
};

export const DEFAULT_RPC_URLS: Record<number, string> = {
  [MONAD_MAINNET_CHAIN_ID]: 'https://rpc.monad.xyz',
  [MONAD_TESTNET_CHAIN_ID]: 'https://testnet-rpc.monad.xyz',
};

export function getDefaultChainId(network: NetworkName): number {
  return DEFAULT_CHAIN_IDS[network];
}

export function getDefaultRpcUrl(chainId: number): string | undefined {
  return DEFAULT_RPC_URLS[chainId];
}

export function getDefaultRpcUrls(chainId: number): Record<number, string> {
  const url = DEFAULT_RPC_URLS[chainId];
  if (url) {
    return { [chainId]: url };
  }
  return {};
}

