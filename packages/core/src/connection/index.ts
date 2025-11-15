import { Effect, Schedule, Fiber } from 'effect';
import type { PooledConnection, ConnectionPoolConfig, ConnectionPoolStats } from './types';
import { DEFAULT_CONFIG } from './types';
import * as lifecycle from './lifecycle';
import { getStats } from './stats';

export type PoolState = {
  config: ConnectionPoolConfig;
  connections: Map<string, PooledConnection[]>;
  cleanupTimer?: Timer;
  cleanupFiber?: Fiber.RuntimeFiber<number | void, never>;
  closed: boolean;
};

export namespace Pool {
  export function createState(config: Partial<ConnectionPoolConfig> = {}): PoolState {
    return {
      config: { ...DEFAULT_CONFIG, ...config },
      connections: new Map(),
      cleanupTimer: undefined,
      closed: false,
    };
  }

  export async function acquire(
    state: PoolState,
    peerId: string,
    protocol: string,
    createFn: () => Promise<any>
  ): Promise<{ connection: PooledConnection; state: PoolState }> {
    if (state.closed) {
      throw new Error('Connection pool is closed');
    }

    const { connection, connections } = await lifecycle.acquire(
      state.connections,
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

  export function release(connection: PooledConnection): PooledConnection {
    return lifecycle.release(connection);
  }

  export async function remove(
    state: PoolState,
    connection: PooledConnection
  ): Promise<PoolState> {
    const connections = await lifecycle.remove(state.connections, connection);
    return { ...state, connections };
  }

  export async function removeAllForPeer(
    state: PoolState,
    peerId: string
  ): Promise<PoolState> {
    const connections = await lifecycle.removeAllForPeer(state.connections, peerId);
    return { ...state, connections };
  }

  export function getPoolStats(state: PoolState): ConnectionPoolStats {
    return getStats(state.connections);
  }

  export async function close(state: PoolState): Promise<PoolState> {
    if (state.closed) {
      return state;
    }

    if (state.cleanupTimer) {
      clearInterval(state.cleanupTimer);
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
      cleanupTimer: undefined,
      closed: true,
    };
  }

  export async function startCleanupTimer(
    state: PoolState,
    onStateUpdate: (updater: (currentState: PoolState) => Promise<PoolState>) => Promise<void>
  ): Promise<PoolState> {
    const cleanupEffect = Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await onStateUpdate(async (currentState) => {
            const connections = await lifecycle.cleanup(currentState.connections, currentState.config);
            return { ...currentState, connections };
          });
        },
        catch: (err) => {
          console.error('Error during connection pool cleanup:', err);
          return err;
        }
      });
    });

    const scheduled = cleanupEffect.pipe(
      Effect.schedule(Schedule.fixed(`${state.config.cleanupInterval} millis`)),
      Effect.catchAll(() => Effect.succeed(void 0))
    );

    const fiber = Effect.runFork(scheduled);

    return { ...state, cleanupFiber: fiber };
  }

  export function stopCleanupTimer(state: PoolState): PoolState {
    if (state.cleanupFiber) {
      Effect.runFork(Fiber.interrupt(state.cleanupFiber));
      return { ...state, cleanupFiber: undefined };
    }
    return state;
  }
}

export type {
  PooledConnection,
  ConnectionPoolConfig,
  ConnectionPoolStats,
} from './types';
export { DEFAULT_CONFIG } from './types';
