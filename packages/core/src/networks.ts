import type { EccoConfig, DiscoveryMethod } from './types';

export interface NetworkConfig {
  networkId: string;
  discovery: DiscoveryMethod[];
  bootstrap: {
    enabled: boolean;
    peers: string[];
    timeout: number;
    minPeers: number;
  };
}

export const OFFICIAL_BOOTSTRAP_PEERS: string[] = [
  // '/ip4/YOUR_SERVER_IP/tcp/4001/p2p/YOUR_PEER_ID',
  // '/dns4/bootstrap.yourdomain.com/tcp/4001/p2p/YOUR_PEER_ID',
];

export const ECCO_MAINNET: NetworkConfig = {
  networkId: 'ecco-mainnet',
  discovery: ['dht', 'gossip'],
  bootstrap: {
    enabled: OFFICIAL_BOOTSTRAP_PEERS.length > 0,
    peers: OFFICIAL_BOOTSTRAP_PEERS,
    timeout: 30000,
    minPeers: 1,
  },
};

export const ECCO_TESTNET: NetworkConfig = {
  networkId: 'ecco-testnet',
  discovery: ['dht', 'gossip'],
  bootstrap: {
    enabled: false,
    peers: [],
    timeout: 30000,
    minPeers: 1,
  },
};

export const ECCO_LOCAL: NetworkConfig = {
  networkId: 'ecco-local',
  discovery: ['mdns', 'gossip'],
  bootstrap: {
    enabled: false,
    peers: [],
    timeout: 30000,
    minPeers: 0,
  },
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
  local: ECCO_LOCAL,
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
    fallbackToP2P: true,
    authentication: { enabled: false },
    ...baseConfig,
    networkId: baseConfig.networkId ?? networkConfig.networkId,
    bootstrap: baseConfig.bootstrap ?? networkConfig.bootstrap,
  };
}

export const DEFAULT_NETWORK: NetworkName = 'mainnet';

