import { Effect } from 'effect';
import type { NodeState } from '../node/types';
import { EmbeddingService } from '../services/embedding';

export type SimilarityMethod = 'text-overlap' | 'openai-embedding' | 'peer-embedding' | 'custom';

export interface SimilarityConfig {
  method?: SimilarityMethod;
  threshold?: number;
  openaiApiKey?: string;
  embeddingModel?: string;
  requireExchange?: boolean;
  nodeState?: NodeState;
  customSimilarityFn?: (text1: string, text2: string) => Effect.Effect<number>;
}

export interface SimilarityResult {
  similarity: number;
  method: SimilarityMethod;
}

interface ResponseValue {
  text?: string;
  [key: string]: unknown;
}

function extractText(value: unknown): string {
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
}

function normalizeWhitespace(text: string): string {
  return text
    .split('')
    .map(char => (char === ' ' || char === '\t' || char === '\n' || char === '\r' ? ' ' : char))
    .join('')
    .split(' ')
    .filter(part => part.length > 0)
    .join(' ');
}

function normalizeText(text: string): string {
  return normalizeWhitespace(text.toLowerCase().trim());
}

function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized.split(' ').filter(t => t.length > 0);
}

function jaccardSimilarity(text1: string, text2: string): number {
  const tokens1 = new Set(tokenize(text1));
  const tokens2 = new Set(tokenize(text2));

  const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

function cosineSimilarity(text1: string, text2: string): number {
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
}

function textOverlapSimilarity(text1: string, text2: string): number {
  const normalized1 = normalizeText(text1);
  const normalized2 = normalizeText(text2);

  if (normalized1 === normalized2) return 1.0;

  const jaccard = jaccardSimilarity(normalized1, normalized2);
  const cosine = cosineSimilarity(normalized1, normalized2);

  return 0.4 * jaccard + 0.6 * cosine;
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

function cosineSimilarityFromEmbeddings(embedding1: number[], embedding2: number[]): number {
  let dotProduct = 0;
  let mag1 = 0;
  let mag2 = 0;

  for (let i = 0; i < embedding1.length; i++) {
    dotProduct += embedding1[i] * embedding2[i];
    mag1 += embedding1[i] * embedding1[i];
    mag2 += embedding2[i] * embedding2[i];
  }

  return dotProduct / (Math.sqrt(mag1) * Math.sqrt(mag2));
}

const openaiEmbeddingSimilarity = (
  text1: string,
  text2: string,
  apiKey: string,
  model: string
): Effect.Effect<number> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            input: [normalizeText(text1), normalizeText(text2)],
            model,
          }),
        }),
      catch: (error) => new Error(`OpenAI API request failed: ${error}`),
    });

    if (!response.ok) {
      return yield* Effect.fail(new Error(`OpenAI API error: ${response.statusText}`));
    }

    const data = (yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new Error('Failed to parse OpenAI response'),
    })) as OpenAIEmbeddingResponse;

    const embedding1 = data.data[0].embedding;
    const embedding2 = data.data[1].embedding;

    return cosineSimilarityFromEmbeddings(embedding1, embedding2);
  }).pipe(
    Effect.catchAll(() => Effect.succeed(textOverlapSimilarity(text1, text2)))
  );

const peerEmbeddingSimilarity = (
  text1: string,
  text2: string,
  nodeState: NodeState,
  config: { requireExchange?: boolean; model?: string }
): Effect.Effect<{ similarity: number; state: NodeState }, Error> =>
  Effect.gen(function* () {
    const { embeddings, state } = yield* EmbeddingService.requestEmbeddings(
      nodeState,
      [normalizeText(text1), normalizeText(text2)],
      config
    );

    const similarity = cosineSimilarityFromEmbeddings(embeddings[0], embeddings[1]);

    return { similarity, state };
  }).pipe(
    Effect.catchAll(() =>
      Effect.succeed({
        similarity: textOverlapSimilarity(text1, text2),
        state: nodeState,
      })
    )
  );

export const calculateSimilarity = (
  value1: unknown,
  value2: unknown,
  config: SimilarityConfig
): Effect.Effect<SimilarityResult & { state?: NodeState }, Error> =>
  Effect.gen(function* () {
    const text1 = extractText(value1);
    const text2 = extractText(value2);
    const method = config.method || 'text-overlap';

    let similarity: number;
    let updatedState: NodeState | undefined;

    switch (method) {
      case 'peer-embedding':
        if (!config.nodeState) {
          console.warn('NodeState not provided for peer-embedding, falling back to text-overlap');
          similarity = textOverlapSimilarity(text1, text2);
        } else {
          const result = yield* peerEmbeddingSimilarity(text1, text2, config.nodeState, {
            requireExchange: config.requireExchange,
            model: config.embeddingModel,
          });
          similarity = result.similarity;
          updatedState = result.state;
        }
        break;

      case 'openai-embedding':
        if (!config.openaiApiKey) {
          similarity = textOverlapSimilarity(text1, text2);
        } else {
          similarity = yield* openaiEmbeddingSimilarity(
            text1,
            text2,
            config.openaiApiKey,
            config.embeddingModel || 'text-embedding-3-small'
          );
        }
        break;

      case 'custom':
        if (!config.customSimilarityFn) {
          return yield* Effect.fail(new Error('Custom similarity function not provided'));
        }
        similarity = yield* config.customSimilarityFn(text1, text2);
        break;

      case 'text-overlap':
      default:
        similarity = textOverlapSimilarity(text1, text2);
        break;
    }

    return { similarity, method, state: updatedState };
  });

export const clusterResponses = (
  responses: unknown[],
  config: SimilarityConfig
): Effect.Effect<{ clusters: number[][]; state?: NodeState }, Error> =>
  Effect.gen(function* () {
    const threshold = config.threshold || 0.75;
    const n = responses.length;

    const similarities: number[][] = Array(n)
      .fill(0)
      .map(() => Array(n).fill(0));

    let currentState = config.nodeState;

    for (let i = 0; i < n; i++) {
      similarities[i][i] = 1.0;

      for (let j = i + 1; j < n; j++) {
        const result = yield* calculateSimilarity(responses[i], responses[j], {
          ...config,
          nodeState: currentState,
        });
        similarities[i][j] = result.similarity;
        similarities[j][i] = result.similarity;
        if (result.state) {
          currentState = result.state;
        }
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

    return { clusters, state: currentState };
  });

export const findConsensus = (
  responses: unknown[],
  config: SimilarityConfig
): Effect.Effect<{ consensusIndices: number[]; confidence: number; clusters: number[][]; state?: NodeState }, Error> =>
  Effect.gen(function* () {
    if (responses.length === 0) {
      return yield* Effect.fail(new Error('No responses to find consensus'));
    }

    if (responses.length === 1) {
      return {
        consensusIndices: [0],
        confidence: 1.0,
        clusters: [[0]],
        state: config.nodeState,
      };
    }

    const { clusters, state } = yield* clusterResponses(responses, config);

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
      state,
    };
  });
