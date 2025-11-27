import type { Capability, CapabilityQuery, CapabilityMatch, PeerInfo } from '../types';

export interface MatchWeights {
  typeMatch: number;
  nameMatch: number;
  versionMatch: number;
  featureMatch: number;
  metadataMatch: number;
}

export const DEFAULT_WEIGHTS: MatchWeights = {
  typeMatch: 0.3,
  nameMatch: 0.3,
  versionMatch: 0.1,
  featureMatch: 0.2,
  metadataMatch: 0.1,
};

export function matchPeers(
  peers: PeerInfo[],
  query: CapabilityQuery,
  weights: MatchWeights = DEFAULT_WEIGHTS
): CapabilityMatch[] {
  if (query.requiredCapabilities.length === 0) {
    return peers.map((peer) => ({
      peer,
      matchScore: 1.0,
      matchedCapabilities: peer.capabilities,
    }));
  }

  const matches: CapabilityMatch[] = [];

  for (const peer of peers) {
    const match = matchPeer(peer, query, weights);
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
}

function matchPeer(
  peer: PeerInfo,
  query: CapabilityQuery,
  weights: MatchWeights
): CapabilityMatch | null {
  const matchedCapabilities: Capability[] = [];
  let totalScore = 0;

  for (const required of query.requiredCapabilities) {
    let bestMatch: Capability | null = null;
    let bestScore = 0;

    for (const capability of peer.capabilities) {
      const score = scoreCapability(capability, required, weights);
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
  capability: Capability,
  required: Partial<Capability>,
  weights: MatchWeights
): number {
  let score = 0;

  if (required.type) {
    if (capability.type === required.type) {
      score += weights.typeMatch;
    } else {
      return 0;
    }
  } else {
    score += weights.typeMatch;
  }

  if (required.name) {
    if (capability.name === required.name) {
      score += weights.nameMatch;
    } else if (fuzzyMatch(capability.name, required.name)) {
      score += weights.nameMatch * 0.7;
    } else {
      return 0;
    }
  } else {
    score += weights.nameMatch;
  }

  if (required.version) {
    const versionScore = matchVersion(capability.version, required.version);
    score += weights.versionMatch * versionScore;
  } else {
    score += weights.versionMatch;
  }

  if (required.metadata) {
    const featureScore = matchFeatures(capability.metadata, required.metadata);
    score += (weights.featureMatch + weights.metadataMatch) * featureScore;
  } else {
    score += weights.featureMatch + weights.metadataMatch;
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
