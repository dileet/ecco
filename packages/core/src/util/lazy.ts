/**
 * Lazy evaluation utility
 */

export function lazy<T>(fn: () => T): () => T {
  let value: T | undefined;
  let loaded = false;

  return (): T => {
    if (loaded) return value as T;
    loaded = true;
    value = fn();
    return value as T;
  };
}

export function lazyAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let value: T | undefined;
  let loaded = false;
  let loading: Promise<T> | undefined;

  return async (): Promise<T> => {
    if (loaded) return value as T;
    if (loading) return loading;

    loading = fn().then((result) => {
      loaded = true;
      value = result;
      loading = undefined;
      return result;
    });

    return loading;
  };
}

export function memoize<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
  keyFn?: (...args: Args) => string
): (...args: Args) => Result {
  const cache = new Map<string, Result>();

  return (...args: Args): Result => {
    const key = keyFn ? keyFn(...args) : JSON.stringify(args);

    if (cache.has(key)) {
      return cache.get(key)!;
    }

    const result = fn(...args);
    cache.set(key, result);
    return result;
  };
}
