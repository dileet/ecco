import type { PooledConnection, ConnectionPoolConfig, ConnectionPoolStats } from './types';
import { DEFAULT_CONFIG } from './types';
import * as lifecycle from './lifecycle';
import { getStats } from './stats';

export type PoolState = {
  config: ConnectionPoolConfig;
  connections: Map<string, PooledConnection[]>;
  closed: boolean;
};

export async function cleanupStaleConnections(state: PoolState): Promise<PoolState> {
  const connections = await lifecycle.cleanup(state.connections, state.config);
  return { ...state, connections };
}

export async function acquireConnection(
  state: PoolState,
  peerId: string,
  protocol: string,
  createFn: () => Promise<unknown>
): Promise<{ connection: PooledConnection; state: PoolState }> {
  if (state.closed) {
    throw new Error('Connection pool is closed');
  }

  const cleanedConnections = await lifecycle.cleanup(state.connections, state.config);

  const { connection, connections } = await lifecycle.acquire(
    cleanedConnections,
    state.config,
    peerId,
    protocol,
    createFn
  );

  return {
    connection,
    state: { ...state, connections },
  };
}

export function releaseConnection(connection: PooledConnection): PooledConnection {
  return lifecycle.release(connection);
}

export async function removeConnection(
  state: PoolState,
  connection: PooledConnection
): Promise<PoolState> {
  const connections = await lifecycle.remove(state.connections, connection);
  return { ...state, connections };
}

export async function removeAllConnectionsForPeer(
  state: PoolState,
  peerId: string
): Promise<PoolState> {
  const connections = await lifecycle.removeAllForPeer(state.connections, peerId);
  return { ...state, connections };
}

export function getPoolStats(state: PoolState): ConnectionPoolStats {
  return getStats(state.connections);
}

export async function closePool(state: PoolState): Promise<PoolState> {
  if (state.closed) {
    return state;
  }

  const allConnections: PooledConnection[] = [];
  for (const conns of state.connections.values()) {
    allConnections.push(...conns);
  }

  let connections = state.connections;
  for (const conn of allConnections) {
    connections = await lifecycle.remove(connections, conn);
  }

  return {
    ...state,
    connections: new Map(),
    closed: true,
  };
}

export type {
  PooledConnection,
  ConnectionPoolConfig,
  ConnectionPoolStats,
} from './types';
export { DEFAULT_CONFIG } from './types';
