import type { PooledConnection, ConnectionPoolStats } from './types';

export function getStats(connections: Map<string, PooledConnection[]>): ConnectionPoolStats {
  let total = 0;
  let oldest: number | null = null;
  const byPeer = new Map<string, number>();

  for (const [peerId, conns] of connections.entries()) {
    total += conns.length;
    byPeer.set(peerId, conns.length);

    for (const conn of conns) {
      if (oldest === null || conn.createdAt < oldest) {
        oldest = conn.createdAt;
      }
    }
  }

  return {
    totalConnections: total,
    connectionsByPeer: byPeer,
    oldestConnection: oldest,
  };
}
