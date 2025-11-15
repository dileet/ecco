import { CircuitBreakerOpenError } from '../errors';

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

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeout: 60000,
  halfOpenRequests: 3,
};

export namespace CircuitBreaker {
  export function create(config: Partial<CircuitBreakerConfig> = {}): BreakerState {
    return {
      failures: 0,
      lastFailureTime: 0,
      state: 'closed',
      config: { ...DEFAULT_CONFIG, ...config },
    };
  }

  export async function execute<T>(
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
        throw new CircuitBreakerOpenError({
          message: 'Circuit breaker is open',
          peerId: '',
          resetTimeout: currentBreaker.config.resetTimeout,
          failures: currentBreaker.failures,
        });
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

  export function getState(breaker: BreakerState): CircuitBreakerState {
    return breaker.state;
  }

  export function getFailures(breaker: BreakerState): number {
    return breaker.failures;
  }

  export function reset(breaker: BreakerState): BreakerState {
    return {
      ...breaker,
      failures: 0,
      lastFailureTime: 0,
      state: 'closed',
    };
  }
}

export function withCircuitBreaker<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
  config?: Partial<CircuitBreakerConfig>
): (...args: Args) => Promise<Result> {
  let breaker = CircuitBreaker.create(config);

  return async (...args: Args): Promise<Result> => {
    const { result, breaker: newBreaker } = await CircuitBreaker.execute(breaker, () =>
      fn(...args)
    );
    breaker = newBreaker;
    return result;
  };
}
