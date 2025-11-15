import { Effect, Ref } from 'effect';
import type { PeerId } from '@libp2p/interface';
import type { NodeState } from './types';
import { announceCapabilities, setupCapabilityTracking } from './capabilities';
import { setupPerformanceTracking } from './performance-tracking-setup';
import { removePeerRef } from './state-ref';

export function setupEventListeners(
  state: NodeState,
  stateRef: Ref.Ref<NodeState>
): void {
  if (!state.node) {
    return;
  }

  const node = state.node;
  const discoveredPeers = new Set<string>();

  node.addEventListener('peer:discovery', async (evt: CustomEvent<{ id: PeerId; multiaddrs: unknown[] }>) => {
    const { id: peerId } = evt.detail;
    const peerIdStr = peerId.toString();

    // Only log and dial if this is the first time discovering this peer
    if (discoveredPeers.has(peerIdStr)) {
      console.log(`[${state.id}] Already discovered ${peerIdStr}, skipping`);
      return;
    }

    discoveredPeers.add(peerIdStr);
    console.log(`[${state.id}] Discovered peer: ${peerIdStr}`);

    try {
      await node.dial(peerId);
      console.log(`[${state.id}] Dialed peer: ${peerIdStr}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (!errorMessage.includes('ECONNREFUSED') && !errorMessage.includes('timeout')) {
        console.warn(`[${state.id}] Failed to dial peer: ${peerIdStr}`, errorMessage);
      }
    }
  });

  node.addEventListener('peer:connect', (evt: CustomEvent<PeerId>) => {
    const peerId = evt.detail.toString();
    console.log('Connected to peer:', peerId);
    handlePeerConnect(stateRef, peerId);
  });

  node.addEventListener('peer:disconnect', (evt: CustomEvent<PeerId>) => {
    const peerId = evt.detail.toString();
    console.log('Disconnected from peer:', peerId);
    Effect.runPromise(removePeerRef(stateRef, peerId));
  });
}

async function handlePeerConnect(
  stateRef: Ref.Ref<NodeState>,
  _peerId: string
): Promise<void> {
  const program = Effect.gen(function* () {
    yield* setupCapabilityTracking(stateRef);
    yield* setupPerformanceTracking(stateRef);
    const state = yield* Ref.get(stateRef);
    yield* Effect.promise(() => announceCapabilities(state));
  });

  await Effect.runPromise(program);
}
