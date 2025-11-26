import { multiaddr } from '@multiformats/multiaddr';
import type { NodeState } from './types';

export interface BootstrapResult {
  success: boolean;
  connectedCount: number;
  failedPeers: string[];
  error?: string;
}

export async function connectToBootstrapPeers(
  state: NodeState,
  signal?: AbortSignal
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

  console.log(`Connecting to ${bootstrapConfig.peers.length} bootstrap peers...`);

  const minPeers = bootstrapConfig.minPeers ?? 1;

  const results = await Promise.all(
    bootstrapConfig.peers.map(async (peerAddr) => {
      try {
        await state.node!.dial(multiaddr(peerAddr), signal ? { signal } : undefined);
        console.log(`Connected to bootstrap peer: ${peerAddr}`);
        return { peerAddr, success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.warn(`Failed to connect to bootstrap peer ${peerAddr}: ${message}`);
        return { peerAddr, success: false };
      }
    })
  );

  const connectedCount = results.filter((r) => r.success).length;
  const failedPeers = results.filter((r) => !r.success).map((r) => r.peerAddr);

  if (connectedCount < minPeers) {
    const message = `Only connected to ${connectedCount}/${minPeers} required bootstrap peers`;
    console.warn(message);

    if (!state.config.fallbackToP2P) {
      return { success: false, connectedCount, failedPeers, error: message };
    }
  } else {
    console.log(`Successfully connected to ${connectedCount}/${bootstrapConfig.peers.length} bootstrap peers`);
  }

  return { success: true, connectedCount, failedPeers };
}
