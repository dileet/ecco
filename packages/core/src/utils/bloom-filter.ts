export interface BloomFilter {
  readonly size: number;
  readonly hashCount: number;
  add: (item: string) => void;
  has: (item: string) => boolean;
  clear: () => void;
  estimatedFillRatio: () => number;
}

interface BloomFilterState {
  bits: Uint8Array;
  size: number;
  hashCount: number;
}

const fnv1aHash = (str: string, seed: number): number => {
  let hash = 2166136261 ^ seed;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash >>> 0;
};

const murmurHash3 = (str: string, seed: number): number => {
  let h1 = seed;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  for (let i = 0; i < str.length; i++) {
    let k1 = str.charCodeAt(i);
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = Math.imul(h1, 5) + 0xe6546b64;
  }

  h1 ^= str.length;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;

  return h1 >>> 0;
};

const getHashPositions = (item: string, size: number, hashCount: number): number[] => {
  const hash1 = fnv1aHash(item, 0);
  const hash2 = murmurHash3(item, 0);
  
  const positions: number[] = [];
  for (let i = 0; i < hashCount; i++) {
    const combinedHash = (hash1 + i * hash2) >>> 0;
    positions.push(combinedHash % size);
  }
  return positions;
};

const setBit = (bits: Uint8Array, position: number): void => {
  const byteIndex = Math.floor(position / 8);
  if (byteIndex < 0 || byteIndex >= bits.length) {
    return;
  }
  const bitIndex = position % 8;
  bits[byteIndex] |= (1 << bitIndex);
};

const getBit = (bits: Uint8Array, position: number): boolean => {
  const byteIndex = Math.floor(position / 8);
  if (byteIndex < 0 || byteIndex >= bits.length) {
    return false;
  }
  const bitIndex = position % 8;
  return (bits[byteIndex] & (1 << bitIndex)) !== 0;
};

export const calculateOptimalSize = (expectedItems: number, falsePositiveRate: number): number => {
  const size = Math.ceil(
    -(expectedItems * Math.log(falsePositiveRate)) / (Math.log(2) ** 2)
  );
  return Math.max(64, size);
};

export const calculateOptimalHashCount = (size: number, expectedItems: number): number => {
  const hashCount = Math.ceil((size / expectedItems) * Math.log(2));
  return Math.max(1, Math.min(hashCount, 16));
};

export const createBloomFilter = (
  expectedItems: number = 10000,
  falsePositiveRate: number = 0.001
): BloomFilter => {
  if (falsePositiveRate <= 0 || falsePositiveRate >= 1) {
    throw new Error(`Invalid false positive rate: ${falsePositiveRate}. Must be between 0 and 1 exclusive.`);
  }
  if (expectedItems <= 0 || !Number.isInteger(expectedItems)) {
    throw new Error(`Invalid expectedItems: ${expectedItems}. Must be a positive integer.`);
  }
  const size = calculateOptimalSize(expectedItems, falsePositiveRate);
  const hashCount = calculateOptimalHashCount(size, expectedItems);
  const byteSize = Math.ceil(size / 8);

  const state: BloomFilterState = {
    bits: new Uint8Array(byteSize),
    size,
    hashCount,
  };

  return {
    get size() {
      return state.size;
    },

    get hashCount() {
      return state.hashCount;
    },

    add(item: string): void {
      const positions = getHashPositions(item, state.size, state.hashCount);
      for (const pos of positions) {
        setBit(state.bits, pos);
      }
    },

    has(item: string): boolean {
      const positions = getHashPositions(item, state.size, state.hashCount);
      for (const pos of positions) {
        if (!getBit(state.bits, pos)) {
          return false;
        }
      }
      return true;
    },

    clear(): void {
      state.bits.fill(0);
    },

    estimatedFillRatio(): number {
      let setBits = 0;
      for (let i = 0; i < state.bits.length; i++) {
        let byte = state.bits[i];
        while (byte) {
          setBits += byte & 1;
          byte >>>= 1;
        }
      }
      return setBits / state.size;
    },
  };
};

export interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimiter {
  checkAndConsume: (peerId: string, tokens?: number) => boolean;
  getRemainingTokens: (peerId: string) => number;
  reset: (peerId: string) => void;
  clear: () => void;
}

interface RateLimiterState {
  buckets: Map<string, RateLimitBucket>;
  maxTokens: number;
  refillRate: number;
  refillIntervalMs: number;
}

export const createRateLimiter = (
  maxTokens: number = 100,
  refillRate: number = 10,
  refillIntervalMs: number = 1000
): RateLimiter => {
  if (maxTokens <= 0 || refillRate <= 0 || refillIntervalMs <= 0) {
    throw new Error('Rate limiter parameters must be positive numbers');
  }
  const state: RateLimiterState = {
    buckets: new Map(),
    maxTokens,
    refillRate,
    refillIntervalMs,
  };

  const refillBucket = (bucket: RateLimitBucket, now: number): void => {
    const elapsed = now - bucket.lastRefill;
    const refillCount = Math.floor(elapsed / state.refillIntervalMs);
    
    if (refillCount > 0) {
      bucket.tokens = Math.min(
        state.maxTokens,
        bucket.tokens + refillCount * state.refillRate
      );
      bucket.lastRefill = now;
    }
  };

  const getOrCreateBucket = (peerId: string): RateLimitBucket => {
    let bucket = state.buckets.get(peerId);
    if (!bucket) {
      bucket = { tokens: state.maxTokens, lastRefill: Date.now() };
      state.buckets.set(peerId, bucket);
    }
    return bucket;
  };

  return {
    checkAndConsume(peerId: string, tokens: number = 1): boolean {
      const bucket = getOrCreateBucket(peerId);
      const now = Date.now();
      refillBucket(bucket, now);

      if (bucket.tokens >= tokens) {
        bucket.tokens -= tokens;
        return true;
      }
      return false;
    },

    getRemainingTokens(peerId: string): number {
      const bucket = getOrCreateBucket(peerId);
      const now = Date.now();
      refillBucket(bucket, now);
      return bucket.tokens;
    },

    reset(peerId: string): void {
      state.buckets.delete(peerId);
    },

    clear(): void {
      state.buckets.clear();
    },
  };
};

export interface MessageDeduplicator {
  isDuplicate: (messageId: string) => boolean;
  markSeen: (messageId: string) => void;
  shouldRotate: () => boolean;
  rotate: () => void;
}

interface DeduplicatorState {
  currentFilter: BloomFilter;
  previousFilter: BloomFilter | null;
  itemCount: number;
  maxItems: number;
  falsePositiveRate: number;
}

export const createMessageDeduplicator = (
  maxItems: number = 10000,
  falsePositiveRate: number = 0.01
): MessageDeduplicator => {
  const state: DeduplicatorState = {
    currentFilter: createBloomFilter(maxItems, falsePositiveRate),
    previousFilter: null,
    itemCount: 0,
    maxItems,
    falsePositiveRate,
  };

  return {
    isDuplicate(messageId: string): boolean {
      if (state.currentFilter.has(messageId)) {
        return true;
      }
      if (state.previousFilter && state.previousFilter.has(messageId)) {
        return true;
      }
      return false;
    },

    markSeen(messageId: string): void {
      state.currentFilter.add(messageId);
      state.itemCount++;
    },

    shouldRotate(): boolean {
      return state.itemCount >= state.maxItems;
    },

    rotate(): void {
      state.previousFilter = state.currentFilter;
      state.currentFilter = createBloomFilter(state.maxItems, state.falsePositiveRate);
      state.itemCount = 0;
    },
  };
};

