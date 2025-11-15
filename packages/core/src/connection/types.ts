import type { Stream } from '@libp2p/interface';

export interface PooledConnection {
  peerId: string;
  stream: Stream;
  protocol: string;
  createdAt: number;
  lastUsed: number;
  useCount: number;
}

export interface ConnectionPoolConfig {
  maxConnectionsPerPeer: number;
  maxIdleTime: number;
  maxConnectionAge: number;
  cleanupInterval: number;
}

export interface ConnectionPoolStats {
  totalConnections: number;
  connectionsByPeer: Map<string, number>;
  oldestConnection: number | null;
}

export const DEFAULT_CONFIG: ConnectionPoolConfig = {
  maxConnectionsPerPeer: 3,
  maxIdleTime: 60000,
  maxConnectionAge: 300000,
  cleanupInterval: 30000,
};
