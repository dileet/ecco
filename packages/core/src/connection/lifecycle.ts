import type { PooledConnection, ConnectionPoolConfig } from './types';

export async function acquire(
  connections: Map<string, PooledConnection[]>,
  config: ConnectionPoolConfig,
  peerId: string,
  protocol: string,
  createFn: () => Promise<any>
): Promise<{ connection: PooledConnection; connections: Map<string, PooledConnection[]> }> {
  const existing = findAvailableConnection(connections, config, peerId, protocol);
  if (existing) {
    const updated: PooledConnection = {
      ...existing,
      lastUsed: Date.now(),
      useCount: existing.useCount + 1,
    };

    const conns = connections.get(peerId);
    if (conns) {
      const index = conns.indexOf(existing);
      if (index >= 0) {
        const updatedConns = [...conns];
        updatedConns[index] = updated;

        const newConnections = new Map(connections);
        newConnections.set(peerId, updatedConns);

        return { connection: updated, connections: newConnections };
      }
    }
  }

  try {
    const stream = await createFn();
    const connection: PooledConnection = {
      peerId,
      stream,
      protocol,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      useCount: 1,
    };

    const newConnections = addConnection(connections, config, connection);
    return { connection, connections: newConnections };
  } catch (error) {
    throw new Error(`Failed to acquire connection to ${peerId}: ${error}`);
  }
}

export function release(connection: PooledConnection): PooledConnection {
  return {
    ...connection,
    lastUsed: Date.now(),
  };
}

export async function remove(
  connections: Map<string, PooledConnection[]>,
  connection: PooledConnection
): Promise<Map<string, PooledConnection[]>> {
  const conns = connections.get(connection.peerId);
  if (!conns) {
    return connections;
  }

  const index = conns.indexOf(connection);
  if (index < 0) {
    return connections;
  }

  try {
    await connection.stream.close();
  } catch (error) {
    console.warn(`Error closing connection to ${connection.peerId}:`, error);
  }

  const newConns = conns.filter((_, i) => i !== index);
  const newConnections = new Map(connections);

  if (newConns.length === 0) {
    newConnections.delete(connection.peerId);
  } else {
    newConnections.set(connection.peerId, newConns);
  }

  return newConnections;
}

export async function removeAllForPeer(
  connections: Map<string, PooledConnection[]>,
  peerId: string
): Promise<Map<string, PooledConnection[]>> {
  const conns = connections.get(peerId);
  if (!conns) {
    return connections;
  }

  let newConnections = connections;
  for (const conn of conns) {
    newConnections = await remove(newConnections, conn);
  }

  return newConnections;
}

export async function cleanup(
  connections: Map<string, PooledConnection[]>,
  config: ConnectionPoolConfig
): Promise<Map<string, PooledConnection[]>> {
  const now = Date.now();
  const toRemove: PooledConnection[] = [];

  for (const conns of connections.values()) {
    for (const conn of conns) {
      if (
        now - conn.lastUsed > config.maxIdleTime ||
        now - conn.createdAt > config.maxConnectionAge
      ) {
        toRemove.push(conn);
      }
    }
  }

  if (toRemove.length === 0) {
    return connections;
  }

  console.log(`Cleaning up ${toRemove.length} stale connections`);

  let newConnections = connections;
  for (const conn of toRemove) {
    newConnections = await remove(newConnections, conn);
  }

  return newConnections;
}

function findAvailableConnection(
  connections: Map<string, PooledConnection[]>,
  config: ConnectionPoolConfig,
  peerId: string,
  protocol: string
): PooledConnection | null {
  const conns = connections.get(peerId);
  if (!conns) {
    return null;
  }

  const now = Date.now();

  for (const conn of conns) {
    if (
      conn.protocol === protocol &&
      now - conn.lastUsed < config.maxIdleTime &&
      now - conn.createdAt < config.maxConnectionAge
    ) {
      return conn;
    }
  }

  return null;
}

function addConnection(
  connections: Map<string, PooledConnection[]>,
  config: ConnectionPoolConfig,
  connection: PooledConnection
): Map<string, PooledConnection[]> {
  const conns = connections.get(connection.peerId) || [];
  let newConns = [...conns];

  if (newConns.length >= config.maxConnectionsPerPeer) {
    const toRemoveIndex = newConns.reduce((oldestIdx, conn, idx, arr) =>
      conn.lastUsed < arr[oldestIdx].lastUsed ? idx : oldestIdx, 0
    );
    const toRemove = newConns[toRemoveIndex];
    newConns.splice(toRemoveIndex, 1);
    toRemove.stream.close().catch(() => {});
  }

  newConns.push(connection);

  const newConnections = new Map(connections);
  newConnections.set(connection.peerId, newConns);

  return newConnections;
}
