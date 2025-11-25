import { Data } from 'effect';

export class AuthenticationError extends Data.TaggedError("AuthenticationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class KeyGenerationError extends Data.TaggedError("KeyGenerationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SignatureError extends Data.TaggedError("SignatureError")<{
  readonly message: string;
  readonly messageId?: string;
  readonly cause?: unknown;
}> {}

export class VerificationError extends Data.TaggedError("VerificationError")<{
  readonly message: string;
  readonly messageId?: string;
  readonly cause?: unknown;
}> {}

export class ConnectionError extends Data.TaggedError("ConnectionError")<{
  readonly message: string;
  readonly peerId: string;
  readonly reason?: string;
  readonly cause?: unknown;
}> {}

export class ConnectionTimeoutError extends Data.TaggedError("ConnectionTimeoutError")<{
  readonly message: string;
  readonly peerId: string;
  readonly timeout: number;
}> {}

export class ConnectionRefusedError extends Data.TaggedError("ConnectionRefusedError")<{
  readonly message: string;
  readonly peerId: string;
  readonly address?: string;
}> {}

export class DialError extends Data.TaggedError("DialError")<{
  readonly message: string;
  readonly peerId: string;
  readonly cause?: unknown;
}> {}

export class DiscoveryError extends Data.TaggedError("DiscoveryError")<{
  readonly message: string;
  readonly strategy: 'local' | 'registry' | 'dht' | 'gossip';
  readonly cause?: unknown;
}> {}

export class PeerDiscoveryError extends Data.TaggedError("PeerDiscoveryError")<{
  readonly message: string;
  readonly query: string;
  readonly cause?: unknown;
}> {}

export class MDNSError extends Data.TaggedError("MDNSError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DHTError extends Data.TaggedError("DHTError")<{
  readonly message: string;
  readonly operation: 'put' | 'get' | 'findPeer' | 'findProviders';
  readonly cause?: unknown;
}> {}

export class RegistryError extends Data.TaggedError("RegistryError")<{
  readonly message: string;
  readonly operation: 'connect' | 'register' | 'unregister' | 'query' | 'disconnect';
  readonly cause?: unknown;
}> {}

export class RegistryConnectionError extends Data.TaggedError("RegistryConnectionError")<{
  readonly message: string;
  readonly endpoint: string;
  readonly cause?: unknown;
}> {}

export class RegistryQueryError extends Data.TaggedError("RegistryQueryError")<{
  readonly message: string;
  readonly query: string;
  readonly cause?: unknown;
}> {}

export class RegistryRegistrationError extends Data.TaggedError("RegistryRegistrationError")<{
  readonly message: string;
  readonly nodeId: string;
  readonly cause?: unknown;
}> {}

export class MessageError extends Data.TaggedError("MessageError")<{
  readonly message: string;
  readonly peerId?: string;
  readonly cause?: unknown;
}> {}

export class PublishError extends Data.TaggedError("PublishError")<{
  readonly message: string;
  readonly topic: string;
  readonly cause?: unknown;
}> {}

export class SubscriptionError extends Data.TaggedError("SubscriptionError")<{
  readonly message: string;
  readonly topic: string;
  readonly cause?: unknown;
}> {}

export class MessageDeliveryError extends Data.TaggedError("MessageDeliveryError")<{
  readonly message: string;
  readonly peerId: string;
  readonly messageId?: string;
  readonly cause?: unknown;
}> {}

export class CapabilityError extends Data.TaggedError("CapabilityError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CapabilityMatchError extends Data.TaggedError("CapabilityMatchError")<{
  readonly message: string;
  readonly query: string;
  readonly cause?: unknown;
}> {}

export class CapabilityAnnouncementError extends Data.TaggedError("CapabilityAnnouncementError")<{
  readonly message: string;
  readonly peerId: string;
  readonly cause?: unknown;
}> {}

export class CapabilityRequestError extends Data.TaggedError("CapabilityRequestError")<{
  readonly message: string;
  readonly requestId: string;
  readonly timeout?: number;
  readonly cause?: unknown;
}> {}

export class NodeStartError extends Data.TaggedError("NodeStartError")<{
  readonly message: string;
  readonly stage: 'auth' | 'discovery' | 'dht' | 'messaging' | 'libp2p' | 'listeners' | 'bootstrap' | 'registry' | 'capabilities' | 'resilience';
  readonly cause?: unknown;
}> {}

export class NodeStopError extends Data.TaggedError("NodeStopError")<{
  readonly message: string;
  readonly stage: 'registry' | 'pool' | 'node';
  readonly cause?: unknown;
}> {}

export class LibP2PInitError extends Data.TaggedError("LibP2PInitError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class BootstrapError extends Data.TaggedError("BootstrapError")<{
  readonly message: string;
  readonly peerId?: string;
  readonly cause?: unknown;
}> {}

export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  readonly message: string;
  readonly operation: string;
  readonly timeout: number;
}> {}

export class RetryableError extends Data.TaggedError("RetryableError")<{
  readonly message: string;
  readonly code?: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly cause?: unknown;
}> {}

export class NonRetryableError extends Data.TaggedError("NonRetryableError")<{
  readonly message: string;
  readonly code?: string;
  readonly cause?: unknown;
}> {}

export class CircuitBreakerError extends Data.TaggedError("CircuitBreakerError")<{
  readonly message: string;
  readonly state: 'open' | 'half-open' | 'closed';
  readonly peerId?: string;
  readonly failures: number;
}> {}

export class CircuitBreakerOpenError extends Data.TaggedError("CircuitBreakerOpenError")<{
  readonly message: string;
  readonly peerId: string;
  readonly resetTimeout: number;
  readonly failures: number;
}> {}

export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  readonly message: string;
  readonly tokensRequired: number;
  readonly tokensAvailable: number;
  readonly retryAfter: number;
}> {}

export class PoolError extends Data.TaggedError("PoolError")<{
  readonly message: string;
  readonly operation: 'acquire' | 'release' | 'close';
  readonly cause?: unknown;
}> {}

export class PoolExhaustedError extends Data.TaggedError("PoolExhaustedError")<{
  readonly message: string;
  readonly maxSize: number;
  readonly timeout: number;
}> {}

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
  readonly field?: string;
  readonly cause?: unknown;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
  readonly field: string;
  readonly value: unknown;
  readonly constraint: string;
}> {}

export class PaymentError extends Data.TaggedError("PaymentError")<{
  readonly message: string;
  readonly invoiceId?: string;
  readonly cause?: unknown;
}> {}

export class PaymentVerificationError extends Data.TaggedError("PaymentVerificationError")<{
  readonly message: string;
  readonly txHash: string;
  readonly chainId: number;
  readonly cause?: unknown;
}> {}

export class InvoiceExpiredError extends Data.TaggedError("InvoiceExpiredError")<{
  readonly message: string;
  readonly invoiceId: string;
  readonly validUntil: number;
  readonly currentTime: number;
}> {}

export class WalletError extends Data.TaggedError("WalletError")<{
  readonly message: string;
  readonly operation?: 'createState' | 'pay' | 'verify' | 'getClient' | 'getAddress';
  readonly cause?: unknown;
}> {}

export type AuthError =
  | AuthenticationError
  | KeyGenerationError
  | SignatureError
  | VerificationError;

export type ConnectError =
  | ConnectionError
  | ConnectionTimeoutError
  | ConnectionRefusedError
  | DialError;

export type DiscoveryErrorType =
  | DiscoveryError
  | PeerDiscoveryError
  | MDNSError
  | DHTError;

export type RegistryErrorType =
  | RegistryError
  | RegistryConnectionError
  | RegistryQueryError
  | RegistryRegistrationError;

export type MessagingError =
  | MessageError
  | PublishError
  | SubscriptionError
  | MessageDeliveryError;

export type CapabilityErrorType =
  | CapabilityError
  | CapabilityMatchError
  | CapabilityAnnouncementError
  | CapabilityRequestError;

export type ResilienceError =
  | RetryableError
  | NonRetryableError
  | CircuitBreakerError
  | CircuitBreakerOpenError
  | RateLimitError;

export type NodeLifecycleError =
  | NodeStartError
  | NodeStopError
  | LibP2PInitError
  | BootstrapError
  | TimeoutError;

export type PaymentErrorType =
  | PaymentError
  | PaymentVerificationError
  | InvoiceExpiredError
  | WalletError;

export type EccoError =
  | AuthError
  | ConnectError
  | DiscoveryErrorType
  | RegistryErrorType
  | MessagingError
  | CapabilityErrorType
  | ResilienceError
  | NodeLifecycleError
  | PoolError
  | PoolExhaustedError
  | ConfigError
  | ValidationError
  | PaymentErrorType;
