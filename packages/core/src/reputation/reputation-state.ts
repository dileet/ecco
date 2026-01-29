import type { PublicClient } from 'viem';
import { decodeEventLog, keccak256, parseAbiItem, toBytes, zeroAddress } from 'viem';
import { z } from 'zod';
import { getERC8004Addresses } from '../networks';
import type { WalletState } from '../payments/wallet';
import { getAddress, getPublicClient, getWalletClient } from '../payments/wallet';
import {
  computePeerIdHash,
  createIdentityRegistryState,
  createReputationRegistryState,
  giveFeedback,
  getAgentOwner,
  getAgentWallet,
  getClients,
  getSummary,
  readAllFeedback,
  valueToNumber,
} from '../identity';
import type { IdentityRegistryState, ReputationRegistryState } from '../identity';
import {
  createFeedbackContent,
  computeFeedbackHash,
  signFeedback,
  createProviderFeedbackStorage,
  type FeedbackStorage,
} from '../identity/feedback-storage';
import { type StorageProviderConfig, StorageProviderConfigSchema } from '../identity/provider-storage';
import { formatGlobalId } from '../identity/global-id';
import { combineScoresWithAvailability, scoreToDisplay } from '../identity/unified-scoring';
import { REPUTATION } from '../networking/constants';
import { clamp } from '../utils/validation';
import {
  loadLocalReputation,
  writeLocalReputation,
  type LocalReputationRecord,
} from '../storage';

const METADATA_SET_EVENT = parseAbiItem('event MetadataSet(uint256 indexed agentId,string indexed indexedMetadataKey,string metadataKey,bytes metadataValue)');

function recordToLocalReputation(record: LocalReputationRecord): LocalReputation {
  return {
    peerId: record.peerId,
    walletAddress: record.walletAddress,
    agentId: record.agentId ? BigInt(record.agentId) : undefined,
    localScore: record.localScore,
    totalJobs: record.totalJobs,
    successfulJobs: record.successfulJobs,
    failedJobs: record.failedJobs,
    lastInteractionAt: record.lastInteractionAt,
  };
}

function localReputationToRecord(peer: LocalReputation): LocalReputationRecord {
  return {
    peerId: peer.peerId,
    walletAddress: peer.walletAddress,
    agentId: peer.agentId?.toString() ?? null,
    localScore: peer.localScore,
    totalJobs: peer.totalJobs,
    successfulJobs: peer.successfulJobs,
    failedJobs: peer.failedJobs,
    lastSyncedAt: 0,
    lastInteractionAt: peer.lastInteractionAt,
  };
}

const FeedbackDefaultsSchema = z.object({
  tag1: z.string().optional(),
  tag2: z.string().optional(),
  endpoint: z.string().optional(),
});

const FeedbackConfigSchema = z.object({
  storageProvider: StorageProviderConfigSchema.optional(),
  defaults: FeedbackDefaultsSchema.optional(),
});

const ExplicitFeedbackSchema = z.object({
  value: z.number().int().min(-100).max(100),
  valueDecimals: z.number().int().min(0).max(18).optional(),
});

export interface FeedbackDefaults {
  tag1?: string;
  tag2?: string;
  endpoint?: string;
}

export interface FeedbackConfig {
  storageProvider?: StorageProviderConfig;
  defaults?: FeedbackDefaults;
}

export interface FeedbackMetadata {
  createdAt?: string;
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  skill?: string;
  domain?: string;
  context?: string;
  task?: string;
  capability?: 'prompts' | 'resources' | 'tools' | 'completions';
  name?: string;
  mcp?: {
    tool?: string;
    prompt?: string;
    resource?: string;
  };
  a2a?: {
    skills?: string[];
    contextId?: string;
    taskId?: string;
  };
  oasf?: {
    skills?: string[];
    domains?: string[];
  };
  proofOfPayment?: {
    fromAddress: string;
    toAddress: string;
    chainId: string;
    txHash: string;
  };
}

export interface ExplicitFeedbackOptions extends FeedbackMetadata {
  valueDecimals?: number;
}

export interface FeedbackSubmissionResult {
  txHash: `0x${string}`;
  feedbackURI: string;
  feedbackHash: `0x${string}`;
}

export interface LocalReputation {
  peerId: string;
  walletAddress: string | null;
  agentId?: bigint;
  localScore: number;
  totalJobs: number;
  successfulJobs: number;
  failedJobs: number;
  lastInteractionAt: number;
}

export interface ChainReputation {
  feedbackScore: number;
  feedbackValue: bigint;
  feedbackDecimals: number;
  feedbackCount: number;
  lastSyncedAt: number;
}

export interface PendingRating {
  paymentId: `0x${string}`;
  txHash: string;
  payee: `0x${string}`;
  amount: bigint;
  delta: number;
  value: bigint;
  valueDecimals: number;
  timestamp: number;
  recorded: boolean;
  peerId: string;
  agentId?: bigint;
  metadata?: FeedbackMetadata;
}

export interface ReputationState {
  local: Map<string, LocalReputation>;
  chain: Map<string, ChainReputation>;
  peerIdToWallet: Map<string, `0x${string}`>;
  peerIdToAgentId: Map<string, bigint>;
  pendingCommits: PendingRating[];
  commitThreshold: number;
  commitIntervalMs: number;
  lastCommitAt: number;
  chainId: number;
  syncIntervalMs: number;
  identityRegistryAddress: `0x${string}`;
  reputationRegistryAddress: `0x${string}`;
  feedbackStorage: FeedbackStorage | null;
  feedbackDefaults: FeedbackDefaults;
  peerResolver?: PeerResolver;
}

export interface PeerResolverResult {
  agentId?: bigint;
  walletAddress?: `0x${string}`;
}

export type PeerResolver = (peerId: string) => Promise<PeerResolverResult | null>;

export interface ReputationConfig {
  chainId: number;
  commitThreshold?: number;
  commitIntervalMs?: number;
  syncIntervalMs?: number;
  peerResolver?: PeerResolver;
  identityRegistryAddress?: `0x${string}`;
  reputationRegistryAddress?: `0x${string}`;
  feedback?: FeedbackConfig;
}

export function resolveRegistryAddresses(
  chainId: number,
  overrides: {
    identityRegistryAddress?: `0x${string}`;
    reputationRegistryAddress?: `0x${string}`;
  } = {}
): { identityRegistryAddress: `0x${string}`; reputationRegistryAddress: `0x${string}` } {
  const addresses = getERC8004Addresses(chainId);
  return {
    identityRegistryAddress: overrides.identityRegistryAddress ?? addresses?.identityRegistry ?? zeroAddress,
    reputationRegistryAddress: overrides.reputationRegistryAddress ?? addresses?.reputationRegistry ?? zeroAddress,
  };
}

function resolveFeedbackDefaults(defaults: FeedbackDefaults | undefined): FeedbackDefaults {
  if (!defaults) {
    return {};
  }
  const parsed = FeedbackDefaultsSchema.safeParse(defaults);
  if (!parsed.success) {
    throw new Error('Invalid feedback defaults');
  }
  return parsed.data;
}

function resolveFeedbackStorage(storageProvider: StorageProviderConfig | undefined): FeedbackStorage | null {
  if (!storageProvider) {
    return null;
  }
  return createProviderFeedbackStorage(storageProvider);
}

function resolveFeedbackConfig(config: FeedbackConfig | undefined): {
  storage: FeedbackStorage | null;
  defaults: FeedbackDefaults;
} {
  if (!config) {
    return {
      storage: null,
      defaults: {},
    };
  }
  const parsed = FeedbackConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error('Invalid feedback config');
  }
  return {
    storage: resolveFeedbackStorage(parsed.data.storageProvider),
    defaults: resolveFeedbackDefaults(parsed.data.defaults),
  };
}

function getIdentityState(chainId: number, identityRegistryAddress: `0x${string}`): IdentityRegistryState {
  return createIdentityRegistryState(chainId, identityRegistryAddress);
}

function getReputationRegistryState(
  chainId: number,
  reputationRegistryAddress: `0x${string}`,
  identityRegistryAddress: `0x${string}`
): ReputationRegistryState {
  return createReputationRegistryState(chainId, reputationRegistryAddress, identityRegistryAddress);
}

export function createReputationState(config: ReputationConfig): ReputationState {
  const addresses = resolveRegistryAddresses(config.chainId, {
    identityRegistryAddress: config.identityRegistryAddress,
    reputationRegistryAddress: config.reputationRegistryAddress,
  });
  const feedback = resolveFeedbackConfig(config.feedback);
  return {
    local: new Map(),
    chain: new Map(),
    peerIdToWallet: new Map(),
    peerIdToAgentId: new Map(),
    pendingCommits: [],
    commitThreshold: config.commitThreshold ?? REPUTATION.DEFAULT_COMMIT_THRESHOLD,
    commitIntervalMs: config.commitIntervalMs ?? REPUTATION.DEFAULT_COMMIT_INTERVAL_MS,
    lastCommitAt: Date.now(),
    chainId: config.chainId,
    syncIntervalMs: config.syncIntervalMs ?? REPUTATION.DEFAULT_SYNC_INTERVAL_MS,
    identityRegistryAddress: addresses.identityRegistryAddress,
    reputationRegistryAddress: addresses.reputationRegistryAddress,
    feedbackStorage: feedback.storage,
    feedbackDefaults: feedback.defaults,
    peerResolver: config.peerResolver,
  };
}

export async function loadReputationFromStorage(state: ReputationState): Promise<void> {
  const records = await loadLocalReputation();
  for (const record of records) {
    const local = recordToLocalReputation(record);
    state.local.set(local.peerId, local);
    if (local.walletAddress) {
      state.peerIdToWallet.set(local.peerId, local.walletAddress as `0x${string}`);
    }
    if (local.agentId !== undefined) {
      state.peerIdToAgentId.set(local.peerId, local.agentId);
    }
  }
}

export function createDefaultPeerResolver(config: {
  chainId: number;
  wallet: WalletState;
  identityRegistryAddress: `0x${string}`;
}): PeerResolver {
  const publicClient = getPublicClient(config.wallet, config.chainId);
  const identityState = createIdentityRegistryState(config.chainId, config.identityRegistryAddress);

  return async (peerId: string): Promise<PeerResolverResult | null> => {
    if (config.identityRegistryAddress === zeroAddress) {
      return null;
    }

    const peerIdHash = computePeerIdHash(peerId);

    let logs: Awaited<ReturnType<PublicClient['getLogs']>> = [];
    try {
      logs = await publicClient.getLogs({
        address: config.identityRegistryAddress,
        event: METADATA_SET_EVENT,
        fromBlock: 0n,
        toBlock: 'latest',
      });
    } catch {
      return null;
    }

    let matchedAgentId: bigint | null = null;
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: [METADATA_SET_EVENT],
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName !== 'MetadataSet') {
          continue;
        }
        const args = decoded.args;
        if (!args || typeof args !== 'object') {
          continue;
        }
        const indexedMetadataKey = 'indexedMetadataKey' in args && typeof args.indexedMetadataKey === 'string'
          ? args.indexedMetadataKey
          : null;
        const metadataValue = 'metadataValue' in args && typeof args.metadataValue === 'string'
          ? args.metadataValue
          : null;
        const agentId = 'agentId' in args && typeof args.agentId === 'bigint'
          ? args.agentId
          : null;
        if (!indexedMetadataKey || !metadataValue || agentId === null) {
          continue;
        }
        if (indexedMetadataKey !== 'peerIdHash') {
          continue;
        }
        if (metadataValue.toLowerCase() !== peerIdHash.toLowerCase()) {
          continue;
        }
        matchedAgentId = agentId;
      } catch {
        continue;
      }
    }

    if (matchedAgentId === null) {
      return null;
    }

    const agentId = matchedAgentId;

    let walletAddress: `0x${string}` | null = null;
    try {
      const agentWallet = await getAgentWallet(publicClient, identityState, agentId);
      if (agentWallet !== zeroAddress) {
        walletAddress = agentWallet;
      }
    } catch {
    }

    if (!walletAddress) {
      try {
        walletAddress = await getAgentOwner(publicClient, identityState, agentId);
      } catch {
      }
    }

    if (!walletAddress) {
      return { agentId };
    }

    return { agentId, walletAddress };
  };
}

export function getLocalReputation(state: ReputationState, peerId: string): LocalReputation | undefined {
  return state.local.get(peerId);
}

export function getChainReputation(state: ReputationState, peerId: string): ChainReputation | undefined {
  return state.chain.get(peerId);
}

export async function updateLocalScore(state: ReputationState, peerId: string, delta: number): Promise<void> {
  const local = state.local.get(peerId);
  if (!local) return;

  const newScore = local.localScore + delta;
  const clampedScore = Math.max(REPUTATION.MIN_LOCAL_SCORE, Math.min(REPUTATION.MAX_LOCAL_SCORE, newScore));
  if (clampedScore !== newScore) {
    console.warn(`[reputation] Score for peer ${peerId} clamped: ${newScore} -> ${clampedScore}`);
  }

  const updated: LocalReputation = {
    ...local,
    localScore: clampedScore,
    lastInteractionAt: Date.now(),
    successfulJobs: delta > 0 ? local.successfulJobs + 1 : local.successfulJobs,
    failedJobs: delta < 0 ? local.failedJobs + 1 : local.failedJobs,
    totalJobs: local.totalJobs + 1,
  };

  state.local.set(peerId, updated);
  await writeLocalReputation(localReputationToRecord(updated));
}

export async function recordLocalSuccess(state: ReputationState, peerId: string, walletAddress?: string): Promise<void> {
  const now = Date.now();
  const existing = state.local.get(peerId);

  const base: LocalReputation = existing ?? {
    peerId,
    walletAddress: walletAddress ?? null,
    localScore: 0,
    totalJobs: 0,
    successfulJobs: 0,
    failedJobs: 0,
    lastInteractionAt: now,
  };

  const updated: LocalReputation = {
    ...base,
    localScore: Math.min(REPUTATION.MAX_LOCAL_SCORE, base.localScore + 1),
    successfulJobs: base.successfulJobs + 1,
    totalJobs: base.totalJobs + 1,
    lastInteractionAt: now,
    walletAddress: walletAddress && !base.walletAddress ? walletAddress : base.walletAddress,
  };

  state.local.set(peerId, updated);
  await writeLocalReputation(localReputationToRecord(updated));
}

export async function recordLocalFailure(state: ReputationState, peerId: string, walletAddress?: string): Promise<void> {
  const now = Date.now();
  const existing = state.local.get(peerId);

  const base: LocalReputation = existing ?? {
    peerId,
    walletAddress: walletAddress ?? null,
    localScore: 0,
    totalJobs: 0,
    successfulJobs: 0,
    failedJobs: 0,
    lastInteractionAt: now,
  };

  const updated: LocalReputation = {
    ...base,
    localScore: Math.max(REPUTATION.MIN_LOCAL_SCORE, base.localScore - 1),
    failedJobs: base.failedJobs + 1,
    totalJobs: base.totalJobs + 1,
    lastInteractionAt: now,
    walletAddress: walletAddress && !base.walletAddress ? walletAddress : base.walletAddress,
  };

  state.local.set(peerId, updated);
  await writeLocalReputation(localReputationToRecord(updated));
}

export function generatePaymentId(
  txHash: string,
  payer: string,
  payee: string,
  timestamp: number
): `0x${string}` {
  const data = `${txHash}:${payer}:${payee}:${timestamp}`;
  return keccak256(toBytes(data));
}

export async function queueRating(
  state: ReputationState,
  wallet: WalletState,
  peerId: string,
  payeeAddress: `0x${string}`,
  txHash: string,
  amount: bigint,
  delta: number,
  metadata?: FeedbackMetadata
): Promise<void> {
  if (state.pendingCommits.length >= REPUTATION.MAX_PENDING_RATINGS) {
    return;
  }

  const paymentId = generatePaymentId(txHash, wallet.account.address, payeeAddress, Date.now());
  const clampedDelta = Math.max(-5, Math.min(5, delta));
  const value = BigInt(clampedDelta * 20);
  const valueDecimals = 0;
  let agentId: bigint | undefined;
  try {
    const resolved = await resolveAgentIdForPeer(state, wallet, peerId);
    if (resolved !== null) {
      agentId = resolved;
    }
  } catch {
  }

  const rating: PendingRating = {
    paymentId,
    txHash,
    payee: payeeAddress,
    amount,
    delta: clampedDelta,
    value,
    valueDecimals,
    timestamp: Date.now(),
    recorded: false,
    peerId,
    agentId,
    metadata,
  };

  state.pendingCommits = [...state.pendingCommits, rating];
}

export async function commitPendingRatings(
  state: ReputationState,
  wallet: WalletState
): Promise<{ committed: number; failed: number }> {
  const unrecorded = state.pendingCommits.filter((r) => !r.recorded);

  if (unrecorded.length === 0) {
    return { committed: 0, failed: 0 };
  }

  if (state.reputationRegistryAddress === zeroAddress || !state.feedbackStorage) {
    return { committed: 0, failed: unrecorded.length };
  }

  let committed = 0;
  let failed = 0;
  const remaining: PendingRating[] = [];

  for (const rating of state.pendingCommits) {
    if (rating.recorded) {
      continue;
    }
    try {
      const resolvedAgentId = rating.agentId ?? await resolveAgentIdForPeer(state, wallet, rating.peerId);
      if (resolvedAgentId === null) {
        failed += 1;
        remaining.push(rating);
        continue;
      }

      const metadata: FeedbackMetadata = {
        ...rating.metadata,
        createdAt: new Date(rating.timestamp).toISOString(),
        proofOfPayment: {
          fromAddress: getAddress(wallet),
          toAddress: rating.payee,
          chainId: String(state.chainId),
          txHash: rating.txHash,
        },
      };

      await submitFeedbackInternal(
        state,
        wallet,
        resolvedAgentId,
        rating.value,
        rating.valueDecimals,
        metadata
      );

      committed += 1;
    } catch {
      failed += 1;
      remaining.push(rating);
    }
  }

  state.pendingCommits = remaining;
  state.lastCommitAt = Date.now();

  return { committed, failed };
}

async function submitFeedbackInternal(
  state: ReputationState,
  wallet: WalletState,
  agentId: bigint,
  value: bigint,
  valueDecimals: number,
  metadata: FeedbackMetadata
): Promise<FeedbackSubmissionResult> {
  if (state.reputationRegistryAddress === zeroAddress) {
    throw new Error('Reputation registry not configured');
  }
  if (!state.feedbackStorage) {
    throw new Error('Feedback storage not configured');
  }
  if (valueDecimals < 0 || valueDecimals > 18) {
    throw new Error('valueDecimals must be between 0 and 18');
  }
  if (agentId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('AgentId exceeds maximum safe integer');
  }

  const clientAddress = getAddress(wallet);
  const registryId = formatGlobalId(state.chainId, state.identityRegistryAddress);
  const resolvedMetadata: FeedbackMetadata = {
    ...metadata,
    tag1: metadata.tag1 ?? state.feedbackDefaults.tag1,
    tag2: metadata.tag2 ?? state.feedbackDefaults.tag2,
    endpoint: metadata.endpoint ?? state.feedbackDefaults.endpoint,
  };

  const feedbackContent = createFeedbackContent(
    registryId,
    Number(agentId),
    { chainId: state.chainId, address: clientAddress },
    value,
    valueDecimals,
    resolvedMetadata
  );

  const feedbackHash = computeFeedbackHash(feedbackContent);
  const walletClient = getWalletClient(wallet, state.chainId);
  const account = walletClient.account;
  if (!account) {
    throw new Error('Wallet client has no account');
  }

  const signMessage = (message: string): Promise<`0x${string}`> => {
    return walletClient.signMessage({ account, message });
  };

  const signedFeedback = await signFeedback(feedbackContent, signMessage);
  const feedbackURI = await state.feedbackStorage.store(signedFeedback);

  const publicClient = getPublicClient(wallet, state.chainId);
  const reputationRegistryState = getReputationRegistryState(
    state.chainId,
    state.reputationRegistryAddress,
    state.identityRegistryAddress
  );

  const txHash = await giveFeedback(
    publicClient,
    walletClient,
    reputationRegistryState,
    agentId,
    value,
    valueDecimals,
    resolvedMetadata.tag1 ?? '',
    resolvedMetadata.tag2 ?? '',
    resolvedMetadata.endpoint ?? '',
    feedbackURI,
    feedbackHash
  );

  return { txHash, feedbackURI, feedbackHash };
}

export async function submitExplicitFeedback(
  state: ReputationState,
  wallet: WalletState,
  peerId: string,
  value: number,
  options?: ExplicitFeedbackOptions
): Promise<FeedbackSubmissionResult> {
  const parsed = ExplicitFeedbackSchema.safeParse({
    value,
    valueDecimals: options?.valueDecimals,
  });
  if (!parsed.success) {
    throw new Error('Invalid feedback value');
  }

  const resolvedAgentId = await resolveAgentIdForPeer(state, wallet, peerId);
  if (resolvedAgentId === null) {
    throw new Error('Unable to resolve agent for peer');
  }

  const { valueDecimals, ...metadata } = options ?? {};
  const resolvedDecimals = parsed.data.valueDecimals ?? 0;
  const feedbackValue = BigInt(parsed.data.value);

  return submitFeedbackInternal(
    state,
    wallet,
    resolvedAgentId,
    feedbackValue,
    resolvedDecimals,
    metadata
  );
}

export function shouldCommit(state: ReputationState): boolean {
  const now = Date.now();
  const pendingCount = state.pendingCommits.filter((r) => !r.recorded).length;

  if (pendingCount >= state.commitThreshold) {
    return true;
  }

  if (now - state.lastCommitAt >= state.commitIntervalMs && pendingCount > 0) {
    return true;
  }

  return false;
}

function computeFeedbackAverage(
  values: bigint[],
  valueDecimals: number[],
  revokedStatuses: boolean[]
): { summaryValue: bigint; summaryValueDecimals: number; count: number } | null {
  let summaryValueDecimals = 0;
  for (let i = 0; i < valueDecimals.length; i += 1) {
    if (revokedStatuses[i]) continue;
    if (valueDecimals[i] > summaryValueDecimals) {
      summaryValueDecimals = valueDecimals[i];
    }
  }

  let count = 0;
  let sum = 0n;
  for (let i = 0; i < values.length; i += 1) {
    if (revokedStatuses[i]) continue;
    const scale = BigInt(summaryValueDecimals - valueDecimals[i]);
    const scaled = values[i] * (10n ** scale);
    sum += scaled;
    count += 1;
  }

  if (count === 0) {
    return null;
  }

  const summaryValue = sum / BigInt(count);
  return { summaryValue, summaryValueDecimals, count };
}

async function fetchFeedbackSignal(
  publicClient: PublicClient,
  reputationRegistryState: ReputationRegistryState,
  agentId: bigint
): Promise<{ score: number | null; count: number; value: bigint | null; decimals: number }> {
  let clients: `0x${string}`[] = [];
  try {
    clients = await getClients(publicClient, reputationRegistryState, agentId);
  } catch {
    return { score: null, count: 0, value: null, decimals: 0 };
  }

  if (clients.length === 0) {
    return { score: null, count: 0, value: null, decimals: 0 };
  }

  let summaryScore: number | null = null;
  let summaryCount = 0;
  let summaryValue: bigint | null = null;
  let summaryDecimals = 0;

  try {
    const summary = await getSummary(publicClient, reputationRegistryState, agentId, clients);
    summaryCount = summary.count;
    if (summary.count > 0) {
      summaryScore = valueToNumber(summary.summaryValue, summary.summaryValueDecimals);
      summaryValue = summary.summaryValue;
      summaryDecimals = summary.summaryValueDecimals;
    }
  } catch {
  }

  try {
    const feedback = await readAllFeedback(publicClient, reputationRegistryState, agentId, clients);
    const computed = computeFeedbackAverage(
      feedback.values,
      feedback.valueDecimalsArr,
      feedback.revokedStatuses
    );
    if (computed) {
      if (summaryScore === null) {
        summaryScore = valueToNumber(computed.summaryValue, computed.summaryValueDecimals);
        summaryValue = computed.summaryValue;
        summaryDecimals = computed.summaryValueDecimals;
      }
      if (summaryCount === 0) {
        summaryCount = computed.count;
      }
    }
  } catch {
  }

  return {
    score: summaryScore,
    count: summaryCount,
    value: summaryValue,
    decimals: summaryDecimals,
  };
}

export async function syncPeerFromChain(
  state: ReputationState,
  wallet: WalletState,
  peerId: string,
  walletAddress: `0x${string}`
): Promise<void> {
  const publicClient = getPublicClient(wallet, state.chainId);
  const reputationRegistryState = getReputationRegistryState(
    state.chainId,
    state.reputationRegistryAddress,
    state.identityRegistryAddress
  );

  const now = Date.now();

  let resolvedAgentId: bigint | null = null;
  try {
    resolvedAgentId = await resolveAgentIdForPeer(state, wallet, peerId);
  } catch {
  }

  if (resolvedAgentId !== null && state.reputationRegistryAddress !== zeroAddress) {
    try {
      const feedback = await fetchFeedbackSignal(publicClient, reputationRegistryState, resolvedAgentId);
      if (feedback.score !== null && feedback.value !== null) {
        state.chain.set(peerId, {
          feedbackScore: feedback.score,
          feedbackValue: feedback.value,
          feedbackDecimals: feedback.decimals,
          feedbackCount: feedback.count,
          lastSyncedAt: now,
        });
      }
    } catch {
    }
  }

  const existing = state.local.get(peerId);
  if (existing) {
    const updated: LocalReputation = {
      ...existing,
      agentId: resolvedAgentId ?? existing.agentId,
      walletAddress,
    };
    state.local.set(peerId, updated);
    await writeLocalReputation(localReputationToRecord(updated));
  } else {
    const newLocal: LocalReputation = {
      peerId,
      walletAddress,
      agentId: resolvedAgentId ?? undefined,
      localScore: 0,
      totalJobs: 0,
      successfulJobs: 0,
      failedJobs: 0,
      lastInteractionAt: now,
    };
    state.local.set(peerId, newLocal);
    await writeLocalReputation(localReputationToRecord(newLocal));
  }
}

export async function syncAllPeersFromChain(
  state: ReputationState,
  wallet: WalletState
): Promise<number> {
  const now = Date.now();
  let synced = 0;

  for (const [peerId, local] of state.local) {
    const chainRep = state.chain.get(peerId);
    const lastSyncedAt = chainRep?.lastSyncedAt ?? 0;
    const staleThreshold = now - state.syncIntervalMs;

    if (local.walletAddress && lastSyncedAt < staleThreshold) {
      try {
        await syncPeerFromChain(state, wallet, peerId, local.walletAddress as `0x${string}`);
        synced += 1;
      } catch {
        continue;
      }
    }
  }

  return synced;
}

export function getEffectiveScore(state: ReputationState, peerId: string): number {
  const local = state.local.get(peerId);
  if (!local) return 0;

  let score = local.localScore;
  const chainRep = state.chain.get(peerId);

  if (chainRep && chainRep.feedbackScore !== null) {
    const clamped = clamp(chainRep.feedbackScore, -100, 100);
    const weight = chainRep.feedbackCount > 0 ? Math.min(1, Math.log10(chainRep.feedbackCount + 1)) : 0;
    score += clamped * weight;
  }

  return score;
}

export function getDiscoveryReputationScore(state: ReputationState, peerId: string): number {
  const local = state.local.get(peerId);
  if (!local) return 0;

  const chainRep = state.chain.get(peerId);
  const feedbackValue = chainRep?.feedbackValue ?? null;
  const feedbackDecimals = chainRep?.feedbackDecimals ?? 0;
  const validationScore = 0;

  const { combined } = combineScoresWithAvailability(
    local.localScore,
    feedbackValue,
    feedbackDecimals,
    validationScore
  );
  const displayScore = scoreToDisplay(combined);
  return clamp(displayScore, 0, 100);
}

export function getPeersByScore(state: ReputationState, limit?: number): LocalReputation[] {
  const peers = Array.from(state.local.values());
  peers.sort((a, b) => getEffectiveScore(state, b.peerId) - getEffectiveScore(state, a.peerId));

  if (limit) {
    return peers.slice(0, limit);
  }
  return peers;
}

export function getCachedWallet(state: ReputationState, peerId: string): `0x${string}` | undefined {
  return state.peerIdToWallet.get(peerId);
}

export function setCachedWallet(state: ReputationState, peerId: string, wallet: `0x${string}`): void {
  state.peerIdToWallet.set(peerId, wallet);
  const local = state.local.get(peerId);
  if (local) {
    state.local.set(peerId, { ...local, walletAddress: wallet });
  }
}

function cachePeerResolution(state: ReputationState, peerId: string, result: PeerResolverResult): void {
  if (result.agentId !== undefined) {
    state.peerIdToAgentId.set(peerId, result.agentId);
  }
  if (result.walletAddress) {
    state.peerIdToWallet.set(peerId, result.walletAddress);
  }
  const local = state.local.get(peerId);
  if (local) {
    state.local.set(peerId, {
      ...local,
      walletAddress: result.walletAddress ?? local.walletAddress,
      agentId: result.agentId ?? local.agentId,
    });
  }
}

async function resolveFromResolver(state: ReputationState, peerId: string): Promise<PeerResolverResult | null> {
  if (!state.peerResolver) {
    return null;
  }
  const result = await state.peerResolver(peerId);
  if (!result) {
    return null;
  }
  cachePeerResolution(state, peerId, result);
  return result;
}

export async function resolvePeerIdentity(
  state: ReputationState,
  wallet: WalletState,
  peerId: string
): Promise<{ agentId: bigint | null; walletAddress: `0x${string}` | null }> {
  const cachedWallet = state.peerIdToWallet.get(peerId) ?? null;
  const cachedAgentId = state.peerIdToAgentId.get(peerId) ?? null;

  let agentId = cachedAgentId;
  let walletAddress = cachedWallet;

  const resolved = (agentId === null || walletAddress === null)
    ? await resolveFromResolver(state, peerId)
    : null;
  if (resolved?.agentId !== undefined) {
    agentId = resolved.agentId;
  }
  if (resolved?.walletAddress) {
    walletAddress = resolved.walletAddress;
  }

  if (!walletAddress && agentId !== null) {
    const publicClient = getPublicClient(wallet, state.chainId);
    if (state.identityRegistryAddress !== zeroAddress) {
      const identityState = getIdentityState(state.chainId, state.identityRegistryAddress);
      try {
        const agentWallet = await getAgentWallet(publicClient, identityState, agentId);
        if (agentWallet !== zeroAddress) {
          walletAddress = agentWallet;
        }
      } catch {
      }
      if (!walletAddress) {
        try {
          walletAddress = await getAgentOwner(publicClient, identityState, agentId);
        } catch {
        }
      }
      if (walletAddress) {
        cachePeerResolution(state, peerId, { agentId, walletAddress });
      }
    }
  }

  return { agentId, walletAddress };
}

export async function resolveWalletForPeer(
  state: ReputationState,
  wallet: WalletState,
  peerId: string
): Promise<`0x${string}` | null> {
  const resolved = await resolvePeerIdentity(state, wallet, peerId);
  return resolved.walletAddress;
}

export async function resolveAgentIdForPeer(
  state: ReputationState,
  wallet: WalletState,
  peerId: string
): Promise<bigint | null> {
  const resolved = await resolvePeerIdentity(state, wallet, peerId);
  return resolved.agentId;
}

export async function resolveAndSyncPeer(
  state: ReputationState,
  wallet: WalletState,
  peerId: string
): Promise<LocalReputation | null> {
  const { walletAddress } = await resolvePeerIdentity(state, wallet, peerId);
  if (!walletAddress) {
    return null;
  }

  await syncPeerFromChain(state, wallet, peerId, walletAddress);
  return state.local.get(peerId) ?? null;
}

export function calculateLocalSuccessRate(local: LocalReputation): number {
  if (local.totalJobs === 0) return 0;
  return local.successfulJobs / local.totalJobs;
}

export function clearStaleEntries(state: ReputationState, maxAgeMs: number): number {
  const now = Date.now();
  const threshold = now - maxAgeMs;
  let removed = 0;

  for (const [peerId, local] of state.local) {
    if (local.lastInteractionAt < threshold) {
      state.local.delete(peerId);
      state.chain.delete(peerId);
      removed += 1;
    }
  }

  return removed;
}

export function createReputationScorer(state: ReputationState | undefined): (peerId: string) => number {
  return (peerId: string): number => {
    if (!state) {
      return 0;
    }
    return getDiscoveryReputationScore(state, peerId);
  };
}
