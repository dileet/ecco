export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeout: number;
  halfOpenRequests: number;
}

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerState {
  failures: number;
  lastFailureTime: number;
  state: CircuitBreakerState;
  config: CircuitBreakerConfig;
}

export interface CircuitBreakerOpenError {
  readonly _tag: 'CircuitBreakerOpenError';
  readonly message: string;
  readonly peerId: string;
  readonly resetTimeout: number;
  readonly failures: number;
}

export const DEFAULT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeout: 60000,
  halfOpenRequests: 3,
};

export const INITIAL_BREAKER_STATE: BreakerState = {
  failures: 0,
  lastFailureTime: 0,
  state: 'closed',
  config: DEFAULT_BREAKER_CONFIG,
};

export async function executeWithBreaker<T>(
  breaker: BreakerState,
  fn: () => Promise<T>
): Promise<{ result: T; breaker: BreakerState }> {
  let currentBreaker = breaker;

  if (currentBreaker.state === 'open') {
    const timeSinceFailure = Date.now() - currentBreaker.lastFailureTime;
    if (timeSinceFailure >= currentBreaker.config.resetTimeout) {
      currentBreaker = {
        ...currentBreaker,
        state: 'half-open',
        failures: 0,
      };
    } else {
      throw {
        _tag: 'CircuitBreakerOpenError',
        message: 'Circuit breaker is open',
        peerId: '',
        resetTimeout: currentBreaker.config.resetTimeout,
        failures: currentBreaker.failures,
      } satisfies CircuitBreakerOpenError;
    }
  }

  try {
    const result = await fn();

    if (currentBreaker.state === 'half-open') {
      currentBreaker = {
        ...currentBreaker,
        state: 'closed',
        failures: 0,
      };
    }

    return { result, breaker: currentBreaker };
  } catch (error) {
    currentBreaker = {
      ...currentBreaker,
      failures: currentBreaker.failures + 1,
      lastFailureTime: Date.now(),
    };

    if (currentBreaker.failures >= currentBreaker.config.failureThreshold) {
      currentBreaker = {
        ...currentBreaker,
        state: 'open',
      };
    }

    throw error;
  }
}
