import { Effect, Duration } from 'effect';
import { RetryableError, TimeoutError } from '../errors';

// Legacy Promise-based utilities (kept for backward compatibility)
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage = 'Operation timed out'
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new RetryableError({
        message: timeoutMessage,
        code: 'TIMEOUT',
        attempt: 1,
        maxAttempts: 1,
      })), timeoutMs)
    ),
  ]);
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  interval = 100,
  timeout = 30000
): Promise<void> {
  const startTime = Date.now();

  while (true) {
    const result = await Promise.resolve(condition());
    if (result) return;

    if (Date.now() - startTime >= timeout) {
      throw new Error('Timeout waiting for condition');
    }

    await sleep(interval);
  }
}

// Effect-based utilities
export function sleepEffect(ms: number): Effect.Effect<void> {
  return Effect.sleep(Duration.millis(ms));
}

export function withTimeoutEffect<A, E>(
  effect: Effect.Effect<A, E>,
  timeoutMs: number,
  timeoutMessage = 'Operation timed out'
): Effect.Effect<A, E | TimeoutError> {
  return effect.pipe(
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () => new TimeoutError({
        message: timeoutMessage,
        operation: 'generic',
        timeout: timeoutMs,
      }),
    })
  );
}

export function waitForEffect(
  condition: () => Effect.Effect<boolean>,
  interval = 100,
  timeout = 30000
): Effect.Effect<void, TimeoutError> {
  return Effect.gen(function* () {
    const startTime = Date.now();

    while (true) {
      const result = yield* condition();
      if (result) return;

      if (Date.now() - startTime >= timeout) {
        return yield* Effect.fail(new TimeoutError({
          message: 'Timeout waiting for condition',
          operation: 'waitFor',
          timeout,
        }));
      }

      yield* sleepEffect(interval);
    }
  });
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function defer<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
