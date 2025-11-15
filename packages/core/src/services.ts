import { Context, Effect, Layer, Ref, Fiber } from 'effect';
import type {
  Capability,
  CapabilityQuery,
  CapabilityMatch,
  PeerInfo,
  Message,
} from './types';
import type {
  AuthConfig,
  SignedMessage,
  AuthState,
} from './auth';
import type {
  MatchWeights,
  MatcherState,
} from './capability-matcher';
import type {
  CircuitBreakerConfig,
  CircuitBreakerState,
  BreakerState,
} from './util/circuit-breaker';
import { Registry } from './registry-client';
import {
  AuthenticationError,
  KeyGenerationError,
  SignatureError,
  VerificationError,
  type AuthError,
  CapabilityMatchError,
  type CapabilityErrorType,
  RegistryError,
  RegistryConnectionError,
  RegistryQueryError,
  RegistryRegistrationError,
  type RegistryErrorType,
  CircuitBreakerOpenError,
  CircuitBreakerError,
} from './errors';

// ============================================================================
// Auth Service
// ============================================================================

export class AuthService extends Context.Tag("AuthService")<
  AuthService,
  {
    readonly generateKeyPair: Effect.Effect<
      { privateKey: CryptoKey; publicKey: CryptoKey },
      KeyGenerationError
    >;
    readonly exportPublicKey: (
      publicKey: CryptoKey
    ) => Effect.Effect<string, AuthenticationError>;
    readonly importPublicKey: (
      publicKeyStr: string
    ) => Effect.Effect<CryptoKey, AuthenticationError>;
    readonly createState: (config: AuthConfig) => Effect.Effect<Ref.Ref<AuthState>>;
    readonly sign: (
      stateRef: Ref.Ref<AuthState>,
      message: Message
    ) => Effect.Effect<SignedMessage, SignatureError>;
    readonly verify: (
      stateRef: Ref.Ref<AuthState>,
      signedMessage: SignedMessage
    ) => Effect.Effect<boolean, VerificationError>;
    readonly isMessageFresh: (
      message: Message,
      maxAgeMs?: number
    ) => Effect.Effect<boolean>;
    readonly clearCache: (stateRef: Ref.Ref<AuthState>) => Effect.Effect<void>;
  }
>() {}

// ============================================================================
// Matcher Service
// ============================================================================

export class MatcherService extends Context.Tag("MatcherService")<
  MatcherService,
  {
    readonly createState: (
      weights?: Partial<MatchWeights>
    ) => Effect.Effect<Ref.Ref<MatcherState>>;
    readonly matchPeers: (
      stateRef: Ref.Ref<MatcherState>,
      peers: PeerInfo[],
      query: CapabilityQuery
    ) => Effect.Effect<CapabilityMatch[], CapabilityMatchError>;
  }
>() {}

// ============================================================================
// Registry Service
// ============================================================================

export interface RegistryClientConfig {
  url: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  timeout?: number;
}

export interface RegistryClientState {
  config: RegistryClientConfig;
  ws: WebSocket | null;
  connected: boolean;
  nodeId?: string;
  messageHandlers: Map<string, (response: any) => void>;
  reconnectTimer?: NodeJS.Timeout;
  pingTimer?: NodeJS.Timeout;
  pingFiber?: Fiber.RuntimeFiber<number | void, never>;
  mode?: 'ws' | 'http';
}

export class RegistryService extends Context.Tag("RegistryService")<
  RegistryService,
  {
    readonly createState: (
      config: RegistryClientConfig
    ) => Effect.Effect<Ref.Ref<RegistryClientState>>;
    readonly connect: (
      stateRef: Ref.Ref<RegistryClientState>
    ) => Effect.Effect<void, RegistryConnectionError>;
    readonly disconnect: (
      stateRef: Ref.Ref<RegistryClientState>
    ) => Effect.Effect<void, RegistryError>;
    readonly register: (
      stateRef: Ref.Ref<RegistryClientState>,
      nodeId: string,
      capabilities: Capability[],
      addresses: string[]
    ) => Effect.Effect<void, RegistryRegistrationError>;
    readonly unregister: (
      stateRef: Ref.Ref<RegistryClientState>
    ) => Effect.Effect<void, RegistryError>;
    readonly query: (
      stateRef: Ref.Ref<RegistryClientState>,
      query: CapabilityQuery
    ) => Effect.Effect<PeerInfo[], RegistryQueryError>;
    readonly isConnected: (
      stateRef: Ref.Ref<RegistryClientState>
    ) => Effect.Effect<boolean>;
  }
>() {}

// ============================================================================
// CircuitBreaker Service
// ============================================================================

export class CircuitBreakerService extends Context.Tag("CircuitBreakerService")<
  CircuitBreakerService,
  {
    readonly createState: (
      config?: Partial<CircuitBreakerConfig>
    ) => Effect.Effect<Ref.Ref<BreakerState>>;
    readonly execute: <A, E>(
      stateRef: Ref.Ref<BreakerState>,
      effect: Effect.Effect<A, E>
    ) => Effect.Effect<A, E | CircuitBreakerOpenError>;
    readonly getState: (
      stateRef: Ref.Ref<BreakerState>
    ) => Effect.Effect<CircuitBreakerState>;
    readonly getFailures: (
      stateRef: Ref.Ref<BreakerState>
    ) => Effect.Effect<number>;
    readonly reset: (stateRef: Ref.Ref<BreakerState>) => Effect.Effect<void>;
  }
>() {}

// ============================================================================
// Service Implementations & Layers
// ============================================================================

// Auth Service Implementation
export const AuthServiceLive = Layer.succeed(AuthService, {
  generateKeyPair: Effect.tryPromise({
    try: async () => {
      if (typeof crypto === 'undefined' || !crypto.subtle) {
        throw new Error('Web Crypto API not available');
      }

      const keyPair = await crypto.subtle.generateKey(
        {
          name: 'ECDSA',
          namedCurve: 'P-256',
        },
        true,
        ['sign', 'verify']
      );

      return {
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
      };
    },
    catch: (error) =>
      new KeyGenerationError({
        message: 'Failed to generate key pair',
        cause: error,
      }),
  }),

  exportPublicKey: (publicKey: CryptoKey) =>
    Effect.tryPromise({
      try: async () => {
        const exported = await crypto.subtle.exportKey('spki', publicKey);
        const base64 = Buffer.from(exported).toString('base64');
        return base64;
      },
      catch: (error) =>
        new AuthenticationError({
          message: 'Failed to export public key',
          cause: error,
        }),
    }),

  importPublicKey: (publicKeyStr: string) =>
    Effect.tryPromise({
      try: async () => {
        const buffer = Buffer.from(publicKeyStr, 'base64');
        return crypto.subtle.importKey(
          'spki',
          buffer,
          {
            name: 'ECDSA',
            namedCurve: 'P-256',
          },
          true,
          ['verify']
        );
      },
      catch: (error) =>
        new AuthenticationError({
          message: 'Failed to import public key',
          cause: error,
        }),
    }),

  createState: (config: AuthConfig) =>
    Ref.make<AuthState>({
      config,
      keyCache: new Map(),
    }),

  sign: (stateRef: Ref.Ref<AuthState>, message: Message) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);

      if (!state.config.enabled || !state.config.privateKey || !state.config.publicKey) {
        return yield* Effect.fail(
          new SignatureError({
            message: 'Authentication not enabled or keys not configured',
            messageId: message.id,
          })
        );
      }

      const payload = createSignaturePayload(message);
      const encoder = new TextEncoder();
      const data = encoder.encode(payload);

      const signature = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.sign(
            {
              name: 'ECDSA',
              hash: { name: 'SHA-256' },
            },
            state.config.privateKey!,
            data
          ),
        catch: (error) =>
          new SignatureError({
            message: 'Failed to sign message',
            messageId: message.id,
            cause: error,
          }),
      });

      const publicKeyStr = yield* Effect.tryPromise({
        try: async () => {
          const exported = await crypto.subtle.exportKey('spki', state.config.publicKey!);
          return Buffer.from(exported).toString('base64');
        },
        catch: (error) =>
          new SignatureError({
            message: 'Failed to export public key',
            messageId: message.id,
            cause: error,
          }),
      });

      return {
        ...message,
        signature: Buffer.from(signature).toString('base64'),
        publicKey: publicKeyStr,
      };
    }),

  verify: (stateRef: Ref.Ref<AuthState>, signedMessage: SignedMessage) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);

      if (!state.config.enabled) {
        return true;
      }

      const result = yield* Effect.tryPromise({
        try: async () => {
          let publicKey = state.keyCache.get(signedMessage.publicKey);

          if (!publicKey) {
            const buffer = Buffer.from(signedMessage.publicKey, 'base64');
            publicKey = await crypto.subtle.importKey(
              'spki',
              buffer,
              {
                name: 'ECDSA',
                namedCurve: 'P-256',
              },
              true,
              ['verify']
            );

            const newCache = new Map(state.keyCache);
            newCache.set(signedMessage.publicKey, publicKey);
            await Ref.update(stateRef, (s) => ({
              ...s,
              keyCache: newCache,
            }));
          }

          const payload = createSignaturePayload(signedMessage);
          const encoder = new TextEncoder();
          const data = encoder.encode(payload);

          const signature = Buffer.from(signedMessage.signature, 'base64');
          const isValid = await crypto.subtle.verify(
            {
              name: 'ECDSA',
              hash: { name: 'SHA-256' },
            },
            publicKey,
            signature,
            data
          );

          return isValid;
        },
        catch: (error) =>
          new VerificationError({
            message: 'Message verification failed',
            messageId: signedMessage.id,
            cause: error,
          }),
      });

      return result;
    }),

  isMessageFresh: (message: Message, maxAgeMs: number = 60000) =>
    Effect.sync(() => {
      const now = Date.now();
      const age = now - message.timestamp;
      return age >= 0 && age <= maxAgeMs;
    }),

  clearCache: (stateRef: Ref.Ref<AuthState>) =>
    Ref.update(stateRef, (state) => ({
      ...state,
      keyCache: new Map(),
    })),
});

// Helper function for Auth service
function createSignaturePayload(message: Message | SignedMessage): string {
  return JSON.stringify({
    id: message.id,
    from: message.from,
    to: message.to,
    type: message.type,
    payload: message.payload,
    timestamp: message.timestamp,
  });
}

// Matcher Service Implementation
export const MatcherServiceLive = Layer.succeed(MatcherService, {
  createState: (weights?: Partial<MatchWeights>) => {
    const DEFAULT_WEIGHTS: MatchWeights = {
      typeMatch: 0.3,
      nameMatch: 0.3,
      versionMatch: 0.1,
      featureMatch: 0.2,
      metadataMatch: 0.1,
    };

    return Ref.make<MatcherState>({
      weights: { ...DEFAULT_WEIGHTS, ...weights },
    });
  },

  matchPeers: (
    stateRef: Ref.Ref<MatcherState>,
    peers: PeerInfo[],
    query: CapabilityQuery
  ) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);

      const matches: CapabilityMatch[] = [];

      for (const peer of peers) {
        const match = matchPeer(state, peer, query);
        if (match && match.matchScore > 0) {
          matches.push(match);
        }
      }

      matches.sort((a, b) => {
        const scoreDiff = Math.abs(a.matchScore - b.matchScore);
        if (scoreDiff > 0.01) {
          return b.matchScore - a.matchScore;
        }
        
        const repA = a.peer.reputation || 0;
        const repB = b.peer.reputation || 0;
        if (repA !== repB) {
          return repB - repA;
        }
        
        return 0;
      });

      return matches;
    }),
});

// Matcher helper functions
function matchPeer(
  state: MatcherState,
  peer: PeerInfo,
  query: CapabilityQuery
): CapabilityMatch | null {
  const matchedCapabilities: Capability[] = [];
  let totalScore = 0;

  for (const required of query.requiredCapabilities) {
    let bestMatch: Capability | null = null;
    let bestScore = 0;

    for (const capability of peer.capabilities) {
      const score = scoreCapability(state, capability, required);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = capability;
      }
    }

    if (bestMatch && bestScore > 0.5) {
      matchedCapabilities.push(bestMatch);
      totalScore += bestScore;
    }
  }

  if (matchedCapabilities.length === 0) {
    return null;
  }

  let matchScore = totalScore / query.requiredCapabilities.length;
  if (query.preferredPeers?.includes(peer.id)) {
    matchScore = Math.min(1.0, matchScore + 0.1);
  }

  return {
    peer,
    matchScore,
    matchedCapabilities,
  };
}

function scoreCapability(
  state: MatcherState,
  capability: Capability,
  required: Partial<Capability>
): number {
  let score = 0;

  if (required.type) {
    if (capability.type === required.type) {
      score += state.weights.typeMatch;
    } else {
      return 0;
    }
  } else {
    score += state.weights.typeMatch;
  }

  if (required.name) {
    if (capability.name === required.name) {
      score += state.weights.nameMatch;
    } else if (fuzzyMatch(capability.name, required.name)) {
      score += state.weights.nameMatch * 0.7;
    } else {
      return 0;
    }
  } else {
    score += state.weights.nameMatch;
  }

  if (required.version) {
    const versionScore = matchVersion(capability.version, required.version);
    score += state.weights.versionMatch * versionScore;
  } else {
    score += state.weights.versionMatch;
  }

  if (required.metadata) {
    const featureScore = matchFeatures(capability.metadata, required.metadata);
    score += (state.weights.featureMatch + state.weights.metadataMatch) * featureScore;
  } else {
    score += state.weights.featureMatch + state.weights.metadataMatch;
  }

  return Math.min(1.0, score);
}

function fuzzyMatch(str1: string, str2: string): boolean {
  const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (s1.includes(s2) || s2.includes(s1)) {
    return true;
  }

  const distance = levenshtein(s1, s2);
  const maxLength = Math.max(s1.length, s2.length);
  const similarity = 1 - distance / maxLength;

  return similarity > 0.7;
}

function levenshtein(str1: string, str2: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}

function matchVersion(have: string, want: string): number {
  const haveV = parseVersion(have);
  const wantV = parseVersion(want);

  if (!haveV || !wantV) {
    return 0.5;
  }

  if (haveV.major === wantV.major && haveV.minor === wantV.minor && haveV.patch === wantV.patch) {
    return 1.0;
  }

  if (haveV.major === wantV.major) {
    if (haveV.minor === wantV.minor) {
      return 0.9;
    }
    if (haveV.minor > wantV.minor) {
      return 0.7;
    }
    return 0.5;
  }

  return 0.2;
}

function parseVersion(version: string): { major: number; minor: number; patch: number } | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

function matchFeatures(
  have: Record<string, unknown> | undefined,
  want: Record<string, unknown>
): number {
  if (!have) {
    return 0;
  }

  let matchCount = 0;
  let totalCount = 0;

  for (const [key, value] of Object.entries(want)) {
    totalCount++;

    if (key === 'features' && Array.isArray(value) && Array.isArray(have.features)) {
      const wantFeatures = value as string[];
      const haveFeatures = have.features as string[];
      const matched = wantFeatures.filter(f => haveFeatures.includes(f)).length;
      matchCount += matched / wantFeatures.length;
    } else if (have[key] === value) {
      matchCount++;
    } else if (typeof value === 'string' && typeof have[key] === 'string') {
      if (fuzzyMatch(have[key] as string, value)) {
        matchCount += 0.7;
      }
    }
  }

  return totalCount > 0 ? matchCount / totalCount : 0;
}

// CircuitBreaker Service Implementation
export const CircuitBreakerServiceLive = Layer.succeed(CircuitBreakerService, {
  createState: (config?: Partial<CircuitBreakerConfig>) => {
    const DEFAULT_CONFIG: CircuitBreakerConfig = {
      failureThreshold: 5,
      resetTimeout: 60000,
      halfOpenRequests: 3,
    };

    return Ref.make<BreakerState>({
      failures: 0,
      lastFailureTime: 0,
      state: 'closed',
      config: { ...DEFAULT_CONFIG, ...config },
    });
  },

  execute: <A, E>(stateRef: Ref.Ref<BreakerState>, effect: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const breaker = yield* Ref.get(stateRef);

      if (breaker.state === 'open') {
        const timeSinceFailure = Date.now() - breaker.lastFailureTime;
        if (timeSinceFailure >= breaker.config.resetTimeout) {
          yield* Ref.update(stateRef, (b) => ({
            ...b,
            state: 'half-open' as CircuitBreakerState,
            failures: 0,
          }));
        } else {
          return yield* Effect.fail(
            new CircuitBreakerOpenError({
              message: 'Circuit breaker is open',
              peerId: '',
              resetTimeout: breaker.config.resetTimeout,
              failures: breaker.failures,
            })
          );
        }
      }

      const result = yield* effect.pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            const updated = yield* Ref.get(stateRef);
            const newFailures = updated.failures + 1;

            if (newFailures >= updated.config.failureThreshold) {
              yield* Ref.update(stateRef, (b) => ({
                ...b,
                failures: newFailures,
                lastFailureTime: Date.now(),
                state: 'open' as CircuitBreakerState,
              }));
            } else {
              yield* Ref.update(stateRef, (b) => ({
                ...b,
                failures: newFailures,
                lastFailureTime: Date.now(),
              }));
            }
          })
        ),
        Effect.tap(() =>
          Effect.gen(function* () {
            const current = yield* Ref.get(stateRef);
            if (current.state === 'half-open') {
              yield* Ref.update(stateRef, (b) => ({
                ...b,
                state: 'closed' as CircuitBreakerState,
                failures: 0,
              }));
            }
          })
        )
      );

      return result;
    }),

  getState: (stateRef: Ref.Ref<BreakerState>) =>
    Effect.gen(function* () {
      const breaker = yield* Ref.get(stateRef);
      return breaker.state;
    }),

  getFailures: (stateRef: Ref.Ref<BreakerState>) =>
    Effect.gen(function* () {
      const breaker = yield* Ref.get(stateRef);
      return breaker.failures;
    }),

  reset: (stateRef: Ref.Ref<BreakerState>) =>
    Ref.update(stateRef, (breaker) => ({
      ...breaker,
      failures: 0,
      lastFailureTime: 0,
      state: 'closed' as CircuitBreakerState,
    })),
});

export const RegistryServiceLive = Layer.succeed(RegistryService, {
  createState: (config: RegistryClientConfig) =>
    Effect.gen(function* () {
      const clientState = Registry.create(config);
      return yield* Ref.make<RegistryClientState>(clientState);
    }),

  connect: (stateRef: Ref.Ref<RegistryClientState>) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const connectedState = yield* Effect.tryPromise({
        try: () => Registry.connect(state),
        catch: (error) =>
          new RegistryConnectionError({
            message: `Failed to connect to registry: ${error instanceof Error ? error.message : 'Unknown error'}`,
            endpoint: state.config.url,
            cause: error,
          }),
      });
      yield* Ref.set(stateRef, connectedState);
    }),

  disconnect: (stateRef: Ref.Ref<RegistryClientState>) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const disconnectedState = yield* Effect.tryPromise({
        try: () => Registry.disconnect(state),
        catch: (error) =>
          new RegistryError({
            message: `Failed to disconnect from registry: ${error instanceof Error ? error.message : 'Unknown error'}`,
            operation: 'disconnect',
            cause: error,
          }),
      });
      yield* Ref.set(stateRef, disconnectedState);
    }),

  register: (
    stateRef: Ref.Ref<RegistryClientState>,
    nodeId: string,
    capabilities: Capability[],
    addresses: string[]
  ) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const registeredState = yield* Effect.tryPromise({
        try: () => Registry.register(state, nodeId, capabilities, addresses),
        catch: (error) =>
          new RegistryRegistrationError({
            message: `Failed to register with registry: ${error instanceof Error ? error.message : 'Unknown error'}`,
            nodeId,
            cause: error,
          }),
      });
      yield* Ref.set(stateRef, registeredState);
    }),

  unregister: (stateRef: Ref.Ref<RegistryClientState>) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const unregisteredState = yield* Effect.tryPromise({
        try: () => Registry.unregister(state),
        catch: (error) =>
          new RegistryError({
            message: `Failed to unregister from registry: ${error instanceof Error ? error.message : 'Unknown error'}`,
            operation: 'unregister',
            cause: error,
          }),
      });
      yield* Ref.set(stateRef, unregisteredState);
    }),

  query: (stateRef: Ref.Ref<RegistryClientState>, query: CapabilityQuery) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const peers = yield* Effect.tryPromise({
        try: () => Registry.query(state, query),
        catch: (error) =>
          new RegistryQueryError({
            message: `Failed to query registry: ${error instanceof Error ? error.message : 'Unknown error'}`,
            query: JSON.stringify(query),
            cause: error,
          }),
      });
      return peers;
    }),

  isConnected: (stateRef: Ref.Ref<RegistryClientState>) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      return Registry.isConnected(state);
    }),
});

// Combined layer with all services
export const ServicesLive = Layer.mergeAll(
  AuthServiceLive,
  MatcherServiceLive,
  CircuitBreakerServiceLive,
  RegistryServiceLive
);
