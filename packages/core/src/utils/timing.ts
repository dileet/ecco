export const delay = (ms: number): Promise<void> => Bun.sleep(ms);

export const spinFor = (ms: number): void => {
  if (ms <= 0) return;
  let now = Date.now();
  const end = now + ms;
  while (now < end) {
    now = Date.now();
  }
};

export const spinBackoff = (attempt: number, stepMs: number, maxMs: number): void => {
  if (attempt <= 0) return;
  const delayMs = Math.min(attempt * stepMs, maxMs);
  spinFor(delayMs);
};

export const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  errorMessage = 'Operation timed out'
): Promise<T> =>
  Promise.race([
    promise,
    delay(ms).then(() => Promise.reject(new Error(errorMessage))),
  ]);

export interface RetryOptions {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  onRetry?: (attempt: number, error: Error) => void;
}

export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> => {
  const { maxAttempts, initialDelay, maxDelay, onRetry } = options;
  let attempt = 0;
  let lastError: Error | undefined;

  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      attempt++;

      if (attempt < maxAttempts) {
        const backoffDelay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
        onRetry?.(attempt, lastError);
        await delay(backoffDelay);
      }
    }
  }

  throw lastError ?? new Error('Retry failed');
};
