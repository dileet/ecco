import { sleep } from './timeout';
import { RetryableError, NonRetryableError } from '../errors';

export interface RetryConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  retryableErrors?: string[];
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  backoffMultiplier: 2,
  retryableErrors: ['TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ERR_NETWORK'],
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  onRetry?: (attempt: number, error: Error) => void
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error;
  let delay = cfg.initialDelay;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (error instanceof NonRetryableError) {
        throw error;
      }

      if (!(error instanceof RetryableError)) {
        const errorCode = (error as any).code || (error as any).errno;
        const isRetryable = cfg.retryableErrors?.some(
          code => errorCode?.includes(code)
        );

        if (!isRetryable && attempt === cfg.maxAttempts) {
          throw error;
        }
      }

      if (attempt === cfg.maxAttempts) {
        throw new RetryableError({
          message: `Operation failed after ${cfg.maxAttempts} attempts: ${lastError.message}`,
          code: (lastError as any).code,
          attempt,
          maxAttempts: cfg.maxAttempts,
          cause: lastError,
        });
      }

      if (onRetry) {
        onRetry(attempt, lastError);
      }

      await sleep(delay);
      delay = Math.min(delay * cfg.backoffMultiplier, cfg.maxDelay);
    }
  }

  throw lastError!;
}

export interface RateLimiterConfig {
  maxTokens: number;
  refillRate: number;
}

export interface RateLimiterState {
  tokens: number;
  lastRefill: number;
  config: RateLimiterConfig;
}

export namespace RateLimiter {
  export function create(config: RateLimiterConfig): RateLimiterState {
    return {
      tokens: config.maxTokens,
      lastRefill: Date.now(),
      config,
    };
  }

  function refill(state: RateLimiterState): RateLimiterState {
    const now = Date.now();
    const elapsed = now - state.lastRefill;
    const tokensToAdd = (elapsed / 1000) * state.config.refillRate;

    return {
      ...state,
      tokens: Math.min(state.config.maxTokens, state.tokens + tokensToAdd),
      lastRefill: now,
    };
  }

  export async function acquire(
    state: RateLimiterState,
    tokens = 1
  ): Promise<RateLimiterState> {
    let currentState = refill(state);

    if (currentState.tokens >= tokens) {
      return {
        ...currentState,
        tokens: currentState.tokens - tokens,
      };
    }

    const tokensNeeded = tokens - currentState.tokens;
    const waitTime = (tokensNeeded / currentState.config.refillRate) * 1000;
    await sleep(waitTime);

    currentState = refill(currentState);
    return {
      ...currentState,
      tokens: currentState.tokens - tokens,
    };
  }

  export function getAvailableTokens(state: RateLimiterState): { tokens: number; state: RateLimiterState } {
    const newState = refill(state);
    return { tokens: newState.tokens, state: newState };
  }
}
