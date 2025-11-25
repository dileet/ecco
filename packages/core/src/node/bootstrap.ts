import { Effect, Ref, Duration } from 'effect';
import { multiaddr } from '@multiformats/multiaddr';
import type { NodeState } from './types';
import { BootstrapError } from '../errors';

export function connectToBootstrapPeers(
  state: NodeState
): Effect.Effect<number, BootstrapError> {
  return Effect.gen(function* () {
    const bootstrapConfig = state.config.bootstrap;
    if (!bootstrapConfig?.enabled || !bootstrapConfig.peers || bootstrapConfig.peers.length === 0) {
      return 0;
    }

    console.log(`Connecting to ${bootstrapConfig.peers.length} bootstrap peers...`);
    const minPeers = bootstrapConfig.minPeers || 1;
    const connectedCountRef = yield* Ref.make(0);

    if (!state.node) {
      return yield* Effect.fail(new BootstrapError({
        message: 'Node not initialized',
        peerId: 'bootstrap',
      }));
    }

    const node = state.node;

    // Use Effect.forEach for structured concurrency
    yield* Effect.forEach(
      bootstrapConfig.peers,
      (peerAddr) =>
        Effect.gen(function* () {
          const addr = multiaddr(peerAddr);
          const dialEffect = Effect.tryPromise({
            try: () => node.dial(addr),
            catch: (error) => new BootstrapError({
              message: `Failed to dial peer: ${error instanceof Error ? error.message : 'Unknown error'}`,
              peerId: peerAddr,
            }),
          });

          const result = yield* dialEffect.pipe(
            Effect.timeoutFail({
              duration: Duration.millis(bootstrapConfig.timeout || 30000),
              onTimeout: () => new BootstrapError({
                message: `Bootstrap peer connection timeout: ${peerAddr}`,
                peerId: peerAddr,
              }),
            }),
            Effect.catchAll((error) => {
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              console.warn(`Failed to connect to bootstrap peer ${peerAddr}: ${errorMessage}`);
              return Effect.succeed(null);
            })
          );

          if (result !== null) {
            yield* Ref.update(connectedCountRef, (count) => count + 1);
            console.log(`Connected to bootstrap peer: ${peerAddr}`);
          }
        }),
      { concurrency: "unbounded" }
    );

    const connectedCount = yield* Ref.get(connectedCountRef);

    if (connectedCount < minPeers) {
      const message = `Only connected to ${connectedCount}/${minPeers} required bootstrap peers`;
      console.warn(message);

      if (!state.config.fallbackToP2P) {
        return yield* Effect.fail(new BootstrapError({
          message,
          peerId: 'bootstrap',
        }));
      }
    } else {
      console.log(`Successfully connected to ${connectedCount}/${bootstrapConfig.peers.length} bootstrap peers`);
    }

    return connectedCount;
  });
}
