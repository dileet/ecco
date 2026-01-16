import type { PublicClient } from 'viem';
import type {
  IdentityRegistryState,
  ReputationRegistryState,
  ValidationRegistryState,
  UnifiedScore,
  ScoringWeights,
} from './types';
import { DEFAULT_SCORING_WEIGHTS } from './types';
import { getAverageScore } from './reputation-registry';

export function normalizeScore(score: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return (score - min) / (max - min);
}

export function normalizeLocalScore(localScore: number): number {
  return normalizeScore(localScore, -1000, 1000);
}

export function normalizeFeedbackScore(feedbackScore: number): number {
  return normalizeScore(feedbackScore, 0, 100);
}

export function normalizeValidationScore(validationScore: number): number {
  return normalizeScore(validationScore, 0, 255);
}

export function combineScores(
  localScore: number,
  feedbackScore: number,
  validationScore: number,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): { combined: number; confidence: number } {
  const normalizedLocal = normalizeLocalScore(localScore);
  const normalizedFeedback = normalizeFeedbackScore(feedbackScore);
  const normalizedValidation = normalizeValidationScore(validationScore);

  const combined =
    normalizedLocal * weights.localScore +
    normalizedFeedback * weights.feedbackScore +
    normalizedValidation * weights.validationScore;

  const hasLocal = localScore !== 0;
  const hasFeedback = feedbackScore > 0;
  const hasValidation = validationScore > 0;
  const sourcesCount = [hasLocal, hasFeedback, hasValidation].filter(Boolean).length;
  const confidence = sourcesCount / 3;

  return { combined, confidence };
}

export async function calculateUnifiedScore(
  publicClient: PublicClient,
  identityState: IdentityRegistryState,
  reputationState: ReputationRegistryState,
  validationState: ValidationRegistryState | null,
  agentId: bigint,
  localScore: number = 0,
  validationScore: number = 0,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): Promise<UnifiedScore> {
  let feedbackScore = 0;
  try {
    feedbackScore = await getAverageScore(publicClient, reputationState, agentId);
  } catch {
  }

  const { combined, confidence } = combineScores(localScore, feedbackScore, validationScore, weights);

  return {
    agentId,
    localScore,
    feedbackScore,
    validationScore,
    combinedScore: combined,
    confidence,
  };
}

export function scoreToDisplay(score: number): number {
  return Math.round(score * 100);
}

export function getScoreRating(combinedScore: number): 'excellent' | 'good' | 'fair' | 'poor' {
  if (combinedScore >= 0.8) return 'excellent';
  if (combinedScore >= 0.6) return 'good';
  if (combinedScore >= 0.4) return 'fair';
  return 'poor';
}

export function compareScores(a: UnifiedScore, b: UnifiedScore): number {
  if (a.combinedScore !== b.combinedScore) {
    return b.combinedScore - a.combinedScore;
  }
  return b.confidence - a.confidence;
}

export function filterByMinScore(
  scores: UnifiedScore[],
  minCombinedScore: number
): UnifiedScore[] {
  return scores.filter((s) => s.combinedScore >= minCombinedScore);
}

export function filterByMinConfidence(
  scores: UnifiedScore[],
  minConfidence: number
): UnifiedScore[] {
  return scores.filter((s) => s.confidence >= minConfidence);
}

export function getTopScoringAgents(
  scores: UnifiedScore[],
  count: number
): UnifiedScore[] {
  return [...scores].sort(compareScores).slice(0, count);
}

export function calculateAverageScore(scores: UnifiedScore[]): number {
  if (scores.length === 0) return 0;
  const sum = scores.reduce((acc, s) => acc + s.combinedScore, 0);
  return sum / scores.length;
}

export function calculateWeightedAverageScore(scores: UnifiedScore[]): number {
  if (scores.length === 0) return 0;
  const totalWeight = scores.reduce((acc, s) => acc + s.confidence, 0);
  if (totalWeight === 0) return 0;
  const weightedSum = scores.reduce((acc, s) => acc + s.combinedScore * s.confidence, 0);
  return weightedSum / totalWeight;
}
