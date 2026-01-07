export { delay, spinFor, spinBackoff, withTimeout, retryWithBackoff, type RetryOptions } from './timing';
export { createLRUCache, cloneLRUCache, fromRecord, type LRUCache } from './lru-cache';
export {
  createBloomFilter,
  createRateLimiter,
  createMessageDeduplicator,
  calculateOptimalSize,
  calculateOptimalHashCount,
  type BloomFilter,
  type RateLimiter,
  type RateLimitBucket,
  type MessageDeduplicator,
} from './bloom-filter';
export { debug } from './debug';
export { secureRandom, isValidBase64, decodeBase64, toHexAddress, validateAddress } from './crypto';
export { canonicalJsonStringify } from './canonical-json';
export { signInvoice, verifyInvoice, isSignedInvoice } from './invoice-signing';

export function normalizeMultiaddrs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((addr) => String(addr));
}
