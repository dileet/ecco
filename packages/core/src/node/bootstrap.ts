import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { z } from 'zod';
import type { NodeState } from './types';

export interface BootstrapResult {
  success: boolean;
  connectedCount: number;
  failedPeers: string[];
  errors: Map<string, string[]>;
  error?: string;
}

const TimeoutSchema = z.number().int().positive();

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
): Promise<{ peerId: string; success: boolean; address?: string; errors: string[] }> {
  if (addresses.length === 0) {
    return { peerId, success: false, errors: ['No addresses provided'] };
  }

  const existingPeers = state.node!.getPeers();
  const peerIdObj = peerIdFromString(peerId);

  if (existingPeers.some(p => p.equals(peerIdObj))) {
    return { peerId, success: true, address: addresses[0], errors: [] };
  }

  const errors: string[] = [];
  for (const addr of addresses) {
    try {
      await dialWithTimeout(state.node, addr, timeoutMs);
      return { peerId, success: true, address: addr, errors };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${addr.split('/').slice(-3).join('/')}: ${msg}`);
      continue;
    }
  }

  return { peerId, success: false, errors };
}

export async function connectToBootstrapPeers(
  state: NodeState
): Promise<BootstrapResult> {
  const bootstrapConfig = state.config.bootstrap;
  const emptyErrors = new Map<string, string[]>();

  if (!bootstrapConfig?.enabled || !bootstrapConfig.peers?.length) {
    return { success: true, connectedCount: 0, failedPeers: [], errors: emptyErrors };
  }

  if (!state.node) {
    return {
      success: false,
      connectedCount: 0,
      failedPeers: bootstrapConfig.peers,
      errors: emptyErrors,
      error: 'Node not initialized',
    };
  }

  const groupedPeers = groupAddressesByPeer(bootstrapConfig.peers);
  const minPeers = bootstrapConfig.minPeers ?? 1;
  const rawTimeout = bootstrapConfig.timeout ?? 10000;
  const timeoutResult = TimeoutSchema.safeParse(rawTimeout);
  const dialTimeout = timeoutResult.success ? timeoutResult.data : 10000;

  const results = await Promise.all(
    Array.from(groupedPeers.entries()).map(([peerId, addresses]) =>
      connectToPeer(state, peerId, addresses, dialTimeout)
    )
  );

  const connectedCount = results.filter((r) => r.success).length;
  const failedPeers = results.filter((r) => !r.success).map((r) => r.peerId);
  const errors = new Map<string, string[]>();
  for (const result of results) {
    if (!result.success && result.errors.length > 0) {
      errors.set(result.peerId, result.errors);
    }
  }

  if (connectedCount < minPeers) {
    const message = `Only connected to ${connectedCount}/${minPeers} required bootstrap peers`;
    return { success: false, connectedCount, failedPeers, errors, error: message };
  }

  return { success: true, connectedCount, failedPeers, errors };
}
