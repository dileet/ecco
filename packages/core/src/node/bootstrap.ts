import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import type { NodeState } from './types';

export interface BootstrapResult {
  success: boolean;
  connectedCount: number;
  failedPeers: string[];
  error?: string;
}

function extractPeerId(addr: string): string | null {
  const match = addr.match(/\/p2p\/([^/]+)$/);
  return match ? match[1] : null;
}

function groupAddressesByPeer(addresses: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const addr of addresses) {
    const peerId = extractPeerId(addr);
    if (peerId) {
      const existing = grouped.get(peerId) ?? [];
      existing.push(addr);
      grouped.set(peerId, existing);
    }
  }
  return grouped;
}

async function dialWithTimeout(
  node: NodeState['node'],
  addr: string,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await node!.dial(multiaddr(addr), { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function connectToPeer(
  state: NodeState,
  peerId: string,
  addresses: string[],
  timeoutMs: number
): Promise<{ peerId: string; success: boolean; address?: string }> {
  const existingPeers = state.node!.getPeers();
  const peerIdObj = peerIdFromString(peerId);
  
  if (existingPeers.some(p => p.equals(peerIdObj))) {
    return { peerId, success: true, address: addresses[0] };
  }

  const errors: string[] = [];
  for (const addr of addresses) {
    try {
      await dialWithTimeout(state.node, addr, timeoutMs);
      return { peerId, success: true, address: addr };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${addr.split('/').slice(-3).join('/')}: ${msg}`);
      continue;
    }
  }

  return { peerId, success: false };
}

export async function connectToBootstrapPeers(
  state: NodeState
): Promise<BootstrapResult> {
  const bootstrapConfig = state.config.bootstrap;

  if (!bootstrapConfig?.enabled || !bootstrapConfig.peers?.length) {
    return { success: true, connectedCount: 0, failedPeers: [] };
  }

  if (!state.node) {
    return {
      success: false,
      connectedCount: 0,
      failedPeers: bootstrapConfig.peers,
      error: 'Node not initialized',
    };
  }

  const groupedPeers = groupAddressesByPeer(bootstrapConfig.peers);
  const uniquePeerCount = groupedPeers.size;
  const minPeers = bootstrapConfig.minPeers ?? 1;
  const dialTimeout = bootstrapConfig.timeout ?? 10000;

  const results = await Promise.all(
    Array.from(groupedPeers.entries()).map(([peerId, addresses]) =>
      connectToPeer(state, peerId, addresses, dialTimeout)
    )
  );

  const connectedCount = results.filter((r) => r.success).length;
  const failedPeers = results.filter((r) => !r.success).map((r) => r.peerId);

  if (connectedCount < minPeers) {
    const message = `Only connected to ${connectedCount}/${minPeers} required bootstrap peers`;

    if (!state.config.fallbackToP2P) {
      return { success: false, connectedCount, failedPeers, error: message };
    }
  }

  return { success: true, connectedCount, failedPeers };
}
