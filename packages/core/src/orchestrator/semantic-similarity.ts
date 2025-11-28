import type { NodeState, StateRef } from '../node/types';
import { requestEmbeddings } from '../services/embedding';

export type SimilarityMethod = 'text-overlap' | 'openai-embedding' | 'peer-embedding' | 'custom';

export type SimilarityConfig = {
  method?: SimilarityMethod;
  threshold?: number;
  openaiApiKey?: string;
  embeddingModel?: string;
  requireExchange?: boolean;
  nodeRef?: StateRef<NodeState>;
  customSimilarityFn?: (text1: string, text2: string) => Promise<number>;
};

export type SimilarityResult = {
  similarity: number;
  method: SimilarityMethod;
};

type ResponseValue = {
  text?: string;
  [key: string]: unknown;
};

type OpenAIEmbeddingResponse = {
  data: Array<{ embedding: number[] }>;
};

const extractText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value !== null) {
    const obj = value as ResponseValue;
    if (obj.text) {
      return obj.text;
    }
    return JSON.stringify(value);
  }

  return String(value);
};

const normalizeWhitespace = (text: string): string =>
  text
    .split('')
    .map((char) => (char === ' ' || char === '\t' || char === '\n' || char === '\r' ? ' ' : char))
    .join('')
    .split(' ')
    .filter((part) => part.length > 0)
    .join(' ');

const normalizeText = (text: string): string => normalizeWhitespace(text.toLowerCase().trim());

const tokenize = (text: string): string[] => {
  const normalized = normalizeText(text);
  return normalized.split(' ').filter((t) => t.length > 0);
};

const jaccardSimilarity = (text1: string, text2: string): number => {
  const tokens1 = new Set(tokenize(text1));
  const tokens2 = new Set(tokenize(text2));

  const intersection = new Set([...tokens1].filter((x) => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
};

const cosineSimilarity = (text1: string, text2: string): number => {
  const tokens1 = tokenize(text1);
  const tokens2 = tokenize(text2);

  const freq1 = new Map<string, number>();
  const freq2 = new Map<string, number>();

  for (const token of tokens1) {
    freq1.set(token, (freq1.get(token) || 0) + 1);
  }

  for (const token of tokens2) {
    freq2.set(token, (freq2.get(token) || 0) + 1);
  }

  const allTokens = new Set([...freq1.keys(), ...freq2.keys()]);

  let dotProduct = 0;
  let mag1 = 0;
  let mag2 = 0;

  for (const token of allTokens) {
    const f1 = freq1.get(token) || 0;
    const f2 = freq2.get(token) || 0;

    dotProduct += f1 * f2;
    mag1 += f1 * f1;
    mag2 += f2 * f2;
  }

  if (mag1 === 0 || mag2 === 0) return 0;

  return dotProduct / (Math.sqrt(mag1) * Math.sqrt(mag2));
};

const textOverlapSimilarity = (text1: string, text2: string): number => {
  const normalized1 = normalizeText(text1);
  const normalized2 = normalizeText(text2);

  if (normalized1 === normalized2) return 1.0;

  const jaccard = jaccardSimilarity(normalized1, normalized2);
  const cosine = cosineSimilarity(normalized1, normalized2);

  return 0.4 * jaccard + 0.6 * cosine;
};

const cosineSimilarityFromEmbeddings = (embedding1: number[], embedding2: number[]): number => {
  let dotProduct = 0;
  let mag1 = 0;
  let mag2 = 0;

  for (let i = 0; i < embedding1.length; i++) {
    dotProduct += embedding1[i] * embedding2[i];
    mag1 += embedding1[i] * embedding1[i];
    mag2 += embedding2[i] * embedding2[i];
  }

  return dotProduct / (Math.sqrt(mag1) * Math.sqrt(mag2));
};

const openaiEmbeddingSimilarity = async (
  text1: string,
  text2: string,
  apiKey: string,
  model: string
): Promise<number> => {
  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: [normalizeText(text1), normalizeText(text2)],
        model,
      }),
    });

    if (!response.ok) {
      return textOverlapSimilarity(text1, text2);
    }

    const data = (await response.json()) as OpenAIEmbeddingResponse;
    const embedding1 = data.data[0].embedding;
    const embedding2 = data.data[1].embedding;

    return cosineSimilarityFromEmbeddings(embedding1, embedding2);
  } catch {
    return textOverlapSimilarity(text1, text2);
  }
};

const peerEmbeddingSimilarity = async (
  text1: string,
  text2: string,
  nodeRef: StateRef<NodeState>,
  config: { requireExchange?: boolean; model?: string }
): Promise<number> => {
  try {
    const embeddings = await requestEmbeddings(
      nodeRef,
      [normalizeText(text1), normalizeText(text2)],
      config
    );

    return cosineSimilarityFromEmbeddings(embeddings[0], embeddings[1]);
  } catch {
    return textOverlapSimilarity(text1, text2);
  }
};

export const calculateSimilarity = async (
  value1: unknown,
  value2: unknown,
  config: SimilarityConfig
): Promise<SimilarityResult> => {
  const text1 = extractText(value1);
  const text2 = extractText(value2);
  const method = config.method || 'text-overlap';

  let similarity: number;

  switch (method) {
    case 'peer-embedding':
      if (!config.nodeRef) {
        similarity = textOverlapSimilarity(text1, text2);
      } else {
        similarity = await peerEmbeddingSimilarity(text1, text2, config.nodeRef, {
          requireExchange: config.requireExchange,
          model: config.embeddingModel,
        });
      }
      break;

    case 'openai-embedding':
      if (!config.openaiApiKey) {
        similarity = textOverlapSimilarity(text1, text2);
      } else {
        similarity = await openaiEmbeddingSimilarity(
          text1,
          text2,
          config.openaiApiKey,
          config.embeddingModel || 'text-embedding-3-small'
        );
      }
      break;

    case 'custom':
      if (!config.customSimilarityFn) {
        throw new Error('Custom similarity function not provided');
      }
      similarity = await config.customSimilarityFn(text1, text2);
      break;

    case 'text-overlap':
    default:
      similarity = textOverlapSimilarity(text1, text2);
      break;
  }

  return { similarity, method };
};

export const clusterResponses = async (
  responses: unknown[],
  config: SimilarityConfig
): Promise<number[][]> => {
  const threshold = config.threshold || 0.75;
  const n = responses.length;

  const similarities: number[][] = Array(n)
    .fill(0)
    .map(() => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    similarities[i][i] = 1.0;

    for (let j = i + 1; j < n; j++) {
      const result = await calculateSimilarity(responses[i], responses[j], config);
      similarities[i][j] = result.similarity;
      similarities[j][i] = result.similarity;
    }
  }

  const visited = new Set<number>();
  const clusters: number[][] = [];

  for (let i = 0; i < n; i++) {
    if (visited.has(i)) continue;

    const cluster = [i];
    visited.add(i);

    for (let j = i + 1; j < n; j++) {
      if (visited.has(j)) continue;

      let isSimilar = false;
      for (const member of cluster) {
        if (similarities[member][j] >= threshold) {
          isSimilar = true;
          break;
        }
      }

      if (isSimilar) {
        cluster.push(j);
        visited.add(j);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
};

export const findConsensus = async (
  responses: unknown[],
  config: SimilarityConfig
): Promise<{ consensusIndices: number[]; confidence: number; clusters: number[][] }> => {
  if (responses.length === 0) {
    throw new Error('No responses to find consensus');
  }

  if (responses.length === 1) {
    return {
      consensusIndices: [0],
      confidence: 1.0,
      clusters: [[0]],
    };
  }

  const clusters = await clusterResponses(responses, config);

  let largestCluster = clusters[0];
  for (const cluster of clusters) {
    if (cluster.length > largestCluster.length) {
      largestCluster = cluster;
    }
  }

  const confidence = largestCluster.length / responses.length;

  return {
    consensusIndices: largestCluster,
    confidence,
    clusters,
  };
};
