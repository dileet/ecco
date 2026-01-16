import { z } from 'zod';

export const HexAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/) as z.ZodType<`0x${string}`>;
export const HexBytes32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/) as z.ZodType<`0x${string}`>;

export const GlobalAgentIdSchema = z.object({
  namespace: z.literal('eip155'),
  chainId: z.number().int().positive(),
  registryAddress: HexAddressSchema,
  agentId: z.bigint(),
});
export type GlobalAgentId = z.infer<typeof GlobalAgentIdSchema>;

export const MetadataEntrySchema = z.object({
  key: z.string().min(1).max(64),
  value: z.instanceof(Uint8Array),
});
export type MetadataEntry = z.infer<typeof MetadataEntrySchema>;

export const AgentStakeSchema = z.object({
  stake: z.bigint(),
  lastActive: z.bigint(),
  unstakeRequestTime: z.bigint(),
  unstakeAmount: z.bigint(),
});
export type AgentStake = z.infer<typeof AgentStakeSchema>;

export const StakeInfoSchema = z.object({
  stake: z.bigint(),
  canWork: z.boolean(),
  effectiveScore: z.bigint(),
  agentId: z.bigint().optional(),
});
export type StakeInfo = z.infer<typeof StakeInfoSchema>;

export const AgentInfoSchema = z.object({
  agentId: z.bigint(),
  owner: HexAddressSchema,
  agentURI: z.string(),
  peerId: z.string().optional(),
  peerIdHash: HexBytes32Schema.optional(),
  stake: AgentStakeSchema.optional(),
  globalId: z.string(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const FeedbackSchema = z.object({
  client: HexAddressSchema,
  score: z.number().int().min(0).max(100),
  tag1: HexBytes32Schema,
  tag2: HexBytes32Schema,
  endpoint: z.string(),
  feedbackURI: z.string(),
  feedbackHash: HexBytes32Schema,
  timestamp: z.bigint(),
  revoked: z.boolean(),
  responseURI: z.string(),
  responseHash: HexBytes32Schema,
});
export type Feedback = z.infer<typeof FeedbackSchema>;

export const FeedbackSummarySchema = z.object({
  count: z.number(),
  averageScore: z.number().min(0).max(100),
});
export type FeedbackSummary = z.infer<typeof FeedbackSummarySchema>;

export const OffChainFeedbackSchema = z.object({
  version: z.literal('1.0'),
  timestamp: z.number(),
  agentGlobalId: z.string(),
  clientAddress: HexAddressSchema,
  score: z.number().int().min(0).max(100),
  tags: z.array(z.string()),
  endpoint: z.string(),
  content: z.object({
    summary: z.string().max(500),
    details: z.string().max(5000).optional(),
    metrics: z.record(z.string(), z.number()).optional(),
  }),
  signature: z.string(),
});
export type OffChainFeedback = z.infer<typeof OffChainFeedbackSchema>;

export const ValidationRequestSchema = z.object({
  requester: HexAddressSchema,
  validator: HexAddressSchema,
  agentId: z.bigint(),
  requestURI: z.string(),
  requestHash: HexBytes32Schema,
  timestamp: z.bigint(),
  responded: z.boolean(),
});
export type ValidationRequest = z.infer<typeof ValidationRequestSchema>;

export const ValidationResponseSchema = z.object({
  response: z.number().int().min(0).max(255),
  responseURI: z.string(),
  responseHash: HexBytes32Schema,
  tag: HexBytes32Schema,
  timestamp: z.bigint(),
});
export type ValidationResponse = z.infer<typeof ValidationResponseSchema>;

export const ValidationSummarySchema = z.object({
  count: z.number(),
  averageResponse: z.number().min(0).max(255),
});
export type ValidationSummary = z.infer<typeof ValidationSummarySchema>;

export const UnifiedScoreSchema = z.object({
  agentId: z.bigint(),
  localScore: z.number(),
  feedbackScore: z.number(),
  validationScore: z.number(),
  combinedScore: z.number(),
  confidence: z.number().min(0).max(1),
});
export type UnifiedScore = z.infer<typeof UnifiedScoreSchema>;

export const ScoringWeightsSchema = z.object({
  localScore: z.number().min(0).max(1),
  feedbackScore: z.number().min(0).max(1),
  validationScore: z.number().min(0).max(1),
});
export type ScoringWeights = z.infer<typeof ScoringWeightsSchema>;

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  localScore: 0.25,
  feedbackScore: 0.50,
  validationScore: 0.25,
};

export interface IdentityRegistryState {
  chainId: number;
  registryAddress: `0x${string}`;
  cachedAgents: Map<bigint, AgentInfo>;
  peerIdToAgentId: Map<string, bigint>;
}

export interface ReputationRegistryState {
  chainId: number;
  registryAddress: `0x${string}`;
  identityRegistryAddress: `0x${string}`;
}

export interface ValidationRegistryState {
  chainId: number;
  registryAddress: `0x${string}`;
  identityRegistryAddress: `0x${string}`;
}
