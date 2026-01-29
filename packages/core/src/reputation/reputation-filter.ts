import type { PrivateKey } from '@libp2p/interface';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import type { EccoEvent } from '../events';
import type { NodeState, StateRef } from '../networking/types';
import { getState, setState } from '../networking/state';
import { publish, subscribeWithRef } from '../networking/messaging';
import { getDiscoveryReputationScore, type ReputationState } from './reputation-state';
import { canonicalJsonStringify } from '../utils/canonical-json';
import { BLOOM_FILTER } from '../networking/constants';

export type FilterTier = 'elite' | 'good' | 'acceptable';

export interface ReputationBloomFilter {
  capability: string;
  tier: FilterTier;
  minReputation: number;
  filter: Uint8Array;
  peerCount: number;
  createdAt: number;
  createdBy: string;
  signature?: Uint8Array;
  publicKey?: Uint8Array;
}

export interface BloomFilterState {
  filters: Map<string, ReputationBloomFilter>;
  localFilters: Map<string, ReputationBloomFilter>;
  filterSize: number;
  hashCount: number;
  gossipIntervalMs: number;
  lastGossipAt: number;
}

export interface BloomFilterConfig {
  filterSize?: number;
  hashCount?: number;
  gossipIntervalMs?: number;
}

const TIER_THRESHOLDS: Record<FilterTier, number> = {
  elite: 90,
  good: 70,
  acceptable: 50,
};

const TIERS: FilterTier[] = ['elite', 'good', 'acceptable'];

const ED25519_SIGNATURE_LENGTH = 64;

function createFilterSignaturePayload(filter: ReputationBloomFilter): Uint8Array {
  const payload = canonicalJsonStringify({
    capability: filter.capability,
    tier: filter.tier,
    minReputation: filter.minReputation,
    filter: Array.from(filter.filter),
    peerCount: filter.peerCount,
    createdAt: filter.createdAt,
    createdBy: filter.createdBy,
  });
  return new TextEncoder().encode(payload);
}

export async function signFilter(
  filter: ReputationBloomFilter,
  privateKey: PrivateKey
): Promise<ReputationBloomFilter> {
  const data = createFilterSignaturePayload(filter);
  const signature = await privateKey.sign(data);
  const publicKeyBytes = privateKey.publicKey.raw;

  return {
    ...filter,
    signature: new Uint8Array(signature),
    publicKey: new Uint8Array(publicKeyBytes),
  };
}

export async function verifyFilter(
  filter: ReputationBloomFilter
): Promise<boolean> {
  if (!filter.signature || !filter.publicKey) {
    return false;
  }

  if (filter.signature.length !== ED25519_SIGNATURE_LENGTH) {
    return false;
  }

  try {
    const publicKey = publicKeyFromRaw(filter.publicKey);
    const derivedPeerId = peerIdFromPublicKey(publicKey);

    if (derivedPeerId.toString().toLowerCase() !== filter.createdBy.toLowerCase()) {
      return false;
    }

    const data = createFilterSignaturePayload(filter);
    return await publicKey.verify(data, filter.signature);
  } catch {
    return false;
  }
}

export function validateFilterParams(
  filter: ReputationBloomFilter,
  expectedSize: number
): boolean {
  if (filter.filter.length !== expectedSize) {
    return false;
  }

  if (filter.filter.length > BLOOM_FILTER.MAX_SIZE) {
    return false;
  }

  const validTiers: FilterTier[] = ['elite', 'good', 'acceptable'];
  if (!validTiers.includes(filter.tier)) {
    return false;
  }

  if (filter.minReputation !== TIER_THRESHOLDS[filter.tier]) {
    return false;
  }

  if (typeof filter.peerCount !== 'number' || filter.peerCount < 0) {
    return false;
  }

  if (typeof filter.createdAt !== 'number' || filter.createdAt <= 0) {
    return false;
  }

  if (typeof filter.createdBy !== 'string' || filter.createdBy.length === 0) {
    return false;
  }

  return true;
}

export function createBloomFilterState(config?: BloomFilterConfig): BloomFilterState {
  return {
    filters: new Map(),
    localFilters: new Map(),
    filterSize: config?.filterSize ?? BLOOM_FILTER.DEFAULT_SIZE,
    hashCount: config?.hashCount ?? BLOOM_FILTER.DEFAULT_HASH_COUNT,
    gossipIntervalMs: config?.gossipIntervalMs ?? BLOOM_FILTER.DEFAULT_GOSSIP_INTERVAL_MS,
    lastGossipAt: 0,
  };
}

function hashString(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function getHashIndices(
  value: string,
  filterSize: number,
  hashCount: number
): number[] {
  const indices: number[] = [];
  for (let i = 0; i < hashCount; i++) {
    const hash = hashString(value, i);
    indices.push(hash % (filterSize * 8));
  }
  return indices;
}

function setBit(filter: Uint8Array, index: number): void {
  const byteIndex = Math.floor(index / 8);
  const bitIndex = index % 8;
  filter[byteIndex] |= 1 << bitIndex;
}

function getBit(filter: Uint8Array, index: number): boolean {
  const byteIndex = Math.floor(index / 8);
  const bitIndex = index % 8;
  return (filter[byteIndex] & (1 << bitIndex)) !== 0;
}

export function createFilter(
  state: BloomFilterState,
  capability: string,
  tier: FilterTier,
  createdBy: string
): ReputationBloomFilter {
  return {
    capability,
    tier,
    minReputation: TIER_THRESHOLDS[tier],
    filter: new Uint8Array(state.filterSize),
    peerCount: 0,
    createdAt: Date.now(),
    createdBy,
  };
}

export function addToFilter(
  state: BloomFilterState,
  filter: ReputationBloomFilter,
  peerId: string
): ReputationBloomFilter {
  const indices = getHashIndices(peerId, state.filterSize, state.hashCount);
  const newFilter = new Uint8Array(filter.filter);

  for (const index of indices) {
    setBit(newFilter, index);
  }

  return {
    ...filter,
    filter: newFilter,
    peerCount: filter.peerCount + 1,
  };
}

export function testFilter(
  state: BloomFilterState,
  filter: ReputationBloomFilter,
  peerId: string
): boolean {
  const indices = getHashIndices(peerId, state.filterSize, state.hashCount);

  for (const index of indices) {
    if (!getBit(filter.filter, index)) {
      return false;
    }
  }

  return true;
}

export function mergeFilters(
  filter1: ReputationBloomFilter,
  filter2: ReputationBloomFilter
): ReputationBloomFilter {
  if (filter1.capability !== filter2.capability || filter1.tier !== filter2.tier) {
    throw new Error('Cannot merge filters with different capability or tier');
  }

  const mergedFilter = new Uint8Array(filter1.filter.length);
  for (let i = 0; i < mergedFilter.length; i++) {
    mergedFilter[i] = filter1.filter[i] | filter2.filter[i];
  }

  return {
    ...filter1,
    filter: mergedFilter,
    peerCount: filter1.peerCount + filter2.peerCount,
    createdAt: Math.max(filter1.createdAt, filter2.createdAt),
  };
}

function getFilterKey(capability: string, tier: FilterTier): string {
  return `${capability}:${tier}`;
}

export function buildLocalFilters(
  bloomState: BloomFilterState,
  reputationState: ReputationState,
  capabilities: string[],
  selfId: string
): BloomFilterState {
  const newLocalFilters = new Map<string, ReputationBloomFilter>();

  for (const capability of capabilities) {
    for (const tier of TIERS) {
      const filter = createFilter(bloomState, capability, tier, selfId);
      let updatedFilter = filter;

      for (const peerId of reputationState.local.keys()) {
        const score = getDiscoveryReputationScore(reputationState, peerId);
        if (score >= TIER_THRESHOLDS[tier]) {
          updatedFilter = addToFilter(bloomState, updatedFilter, peerId);
        }
      }

      if (updatedFilter.peerCount > 0) {
        const key = getFilterKey(capability, tier);
        newLocalFilters.set(key, updatedFilter);
      }
    }
  }

  return {
    ...bloomState,
    localFilters: newLocalFilters,
  };
}

export function receiveFilter(
  bloomState: BloomFilterState,
  filter: ReputationBloomFilter
): BloomFilterState {
  const key = getFilterKey(filter.capability, filter.tier);
  const existing = bloomState.filters.get(key);

  const updatedFilter = existing ? mergeFilters(existing, filter) : filter;

  const newFilters = new Map(bloomState.filters);
  newFilters.set(key, updatedFilter);

  return {
    ...bloomState,
    filters: newFilters,
  };
}

export function queryFilter(
  bloomState: BloomFilterState,
  capability: string,
  tier: FilterTier,
  peerId: string
): boolean {
  const key = getFilterKey(capability, tier);

  const localFilter = bloomState.localFilters.get(key);
  if (localFilter && testFilter(bloomState, localFilter, peerId)) {
    return true;
  }

  const mergedFilter = bloomState.filters.get(key);
  if (mergedFilter && testFilter(bloomState, mergedFilter, peerId)) {
    return true;
  }

  return false;
}

export function findCandidates(
  bloomState: BloomFilterState,
  capability: string,
  peerIds: string[],
  preferredTier?: FilterTier
): { peerId: string; tier: FilterTier }[] {
  const candidates: { peerId: string; tier: FilterTier }[] = [];
  const tiersToCheck = preferredTier ? [preferredTier] : TIERS;

  for (const peerId of peerIds) {
    for (const tier of tiersToCheck) {
      if (queryFilter(bloomState, capability, tier, peerId)) {
        candidates.push({ peerId, tier });
        break;
      }
    }
  }

  const tierOrder: Record<FilterTier, number> = { elite: 0, good: 1, acceptable: 2 };
  candidates.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);

  return candidates;
}

export function serializeFilter(filter: ReputationBloomFilter): string {
  return JSON.stringify({
    ...filter,
    filter: Array.from(filter.filter),
    signature: filter.signature ? Array.from(filter.signature) : undefined,
    publicKey: filter.publicKey ? Array.from(filter.publicKey) : undefined,
  });
}

export function deserializeFilter(data: string): ReputationBloomFilter | null {
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (!Array.isArray(parsed.filter)) {
      return null;
    }
    return {
      ...parsed,
      filter: new Uint8Array(parsed.filter),
      signature: parsed.signature ? new Uint8Array(parsed.signature) : undefined,
      publicKey: parsed.publicKey ? new Uint8Array(parsed.publicKey) : undefined,
    };
  } catch {
    return null;
  }
}

export async function gossipFilters(
  ref: StateRef<NodeState>
): Promise<number> {
  const state = getState(ref);
  if (!state.bloomFilters || !state.node || !state.libp2pPrivateKey) {
    return 0;
  }

  let count = 0;
  for (const filter of state.bloomFilters.localFilters.values()) {
    const signedFilter = await signFilter(filter, state.libp2pPrivateKey);
    const event: EccoEvent = {
      type: 'reputation-filter',
      payload: serializeFilter(signedFilter),
      timestamp: Date.now(),
    };

    await publish(state, BLOOM_FILTER.REPUTATION_FILTERS_TOPIC, event);
    count++;
  }

  const updatedBloomState: BloomFilterState = {
    ...state.bloomFilters,
    lastGossipAt: Date.now(),
  };

  setState(ref, { ...getState(ref), bloomFilters: updatedBloomState });
  return count;
}

async function handleFilterEvent(ref: StateRef<NodeState>, event: EccoEvent): Promise<void> {
  if (event.type !== 'reputation-filter' || typeof event.payload !== 'string') {
    return;
  }

  const state = getState(ref);
  if (!state.bloomFilters) {
    return;
  }

  try {
    const filter = deserializeFilter(event.payload);
    if (!filter) {
      return;
    }

    if (!validateFilterParams(filter, state.bloomFilters.filterSize)) {
      return;
    }

    const isValid = await verifyFilter(filter);
    if (!isValid) {
      return;
    }

    const currentState = getState(ref);
    if (!currentState.bloomFilters) {
      return;
    }

    const updatedBloomState = receiveFilter(currentState.bloomFilters, filter);
    setState(ref, { ...getState(ref), bloomFilters: updatedBloomState });
  } catch {
    return;
  }
}

export function subscribeToFilters(ref: StateRef<NodeState>): () => void {
  const handler = (event: EccoEvent): void => {
    handleFilterEvent(ref, event);
  };

  return subscribeWithRef(ref, BLOOM_FILTER.REPUTATION_FILTERS_TOPIC, handler);
}

export function shouldGossip(bloomState: BloomFilterState): boolean {
  const now = Date.now();
  return now - bloomState.lastGossipAt >= bloomState.gossipIntervalMs;
}

export function estimateFalsePositiveRate(
  filterSize: number,
  hashCount: number,
  itemCount: number
): number {
  const m = filterSize * 8;
  const k = hashCount;
  const n = itemCount;
  return Math.pow(1 - Math.exp(-k * n / m), k);
}

export function getFilterStats(bloomState: BloomFilterState): {
  localFilterCount: number;
  mergedFilterCount: number;
  totalPeersTracked: number;
  estimatedFalsePositiveRate: number;
} {
  let totalPeers = 0;
  for (const filter of bloomState.localFilters.values()) {
    totalPeers += filter.peerCount;
  }

  const avgPeersPerFilter = totalPeers / Math.max(1, bloomState.localFilters.size);
  const estimatedFPR = estimateFalsePositiveRate(
    bloomState.filterSize,
    bloomState.hashCount,
    avgPeersPerFilter
  );

  return {
    localFilterCount: bloomState.localFilters.size,
    mergedFilterCount: bloomState.filters.size,
    totalPeersTracked: totalPeers,
    estimatedFalsePositiveRate: estimatedFPR,
  };
}
