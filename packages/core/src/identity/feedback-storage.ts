import { keccak256, toBytes, toHex } from 'viem';
import { z } from 'zod';
import type { OffChainFeedback } from './types';
import { OffChainFeedbackSchema } from './types';

const HttpStoreResponseSchema = z.object({ uri: z.string() });
const IpfsStoreResponseSchema = z.object({ Hash: z.string() });

export function createFeedbackContent(
  agentGlobalId: string,
  clientAddress: `0x${string}`,
  score: number,
  tags: string[],
  endpoint: string,
  summary: string,
  details?: string,
  metrics?: Record<string, number>
): Omit<OffChainFeedback, 'signature'> {
  return {
    version: '1.0',
    timestamp: Date.now(),
    agentGlobalId,
    clientAddress,
    score,
    tags,
    endpoint,
    content: {
      summary,
      details,
      metrics,
    },
  };
}

export function computeFeedbackHash(feedback: Omit<OffChainFeedback, 'signature'>): `0x${string}` {
  const canonical = JSON.stringify(feedback, Object.keys(feedback).sort());
  return keccak256(toBytes(canonical));
}

export async function signFeedback(
  feedback: Omit<OffChainFeedback, 'signature'>,
  signMessage: (message: string) => Promise<`0x${string}`>
): Promise<OffChainFeedback> {
  const canonical = JSON.stringify(feedback, Object.keys(feedback).sort());
  const signature = await signMessage(canonical);
  return {
    ...feedback,
    signature,
  };
}

export function verifyFeedbackSignature(
  feedback: OffChainFeedback,
  expectedSigner: `0x${string}`,
  recoverAddress: (message: string, signature: `0x${string}`) => Promise<`0x${string}`>
): Promise<boolean> {
  const { signature, ...rest } = feedback;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  return recoverAddress(canonical, signature as `0x${string}`).then(
    (recovered) => recovered.toLowerCase() === expectedSigner.toLowerCase()
  );
}

export function validateFeedback(feedback: unknown): OffChainFeedback {
  return OffChainFeedbackSchema.parse(feedback);
}

export function serializeFeedback(feedback: OffChainFeedback): string {
  return JSON.stringify(feedback, null, 2);
}

export function deserializeFeedback(json: string): OffChainFeedback {
  const parsed = JSON.parse(json);
  return validateFeedback(parsed);
}

export interface FeedbackStorage {
  store(feedback: OffChainFeedback): Promise<string>;
  retrieve(uri: string): Promise<OffChainFeedback | null>;
}

export function createLocalStorage(basePath: string): FeedbackStorage {
  const storage = new Map<string, OffChainFeedback>();

  return {
    async store(feedback: OffChainFeedback): Promise<string> {
      const hash = computeFeedbackHash(feedback);
      const uri = `local://${basePath}/${hash}`;
      storage.set(uri, feedback);
      return uri;
    },

    async retrieve(uri: string): Promise<OffChainFeedback | null> {
      return storage.get(uri) ?? null;
    },
  };
}

export function createHttpStorage(baseUrl: string): FeedbackStorage {
  return {
    async store(feedback: OffChainFeedback): Promise<string> {
      const response = await fetch(`${baseUrl}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: serializeFeedback(feedback),
      });

      if (!response.ok) {
        throw new Error(`Failed to store feedback: ${response.statusText}`);
      }

      const result = HttpStoreResponseSchema.parse(await response.json());
      return result.uri;
    },

    async retrieve(uri: string): Promise<OffChainFeedback | null> {
      try {
        const response = await fetch(uri);
        if (!response.ok) {
          return null;
        }
        const json = await response.text();
        return deserializeFeedback(json);
      } catch {
        return null;
      }
    },
  };
}

export function createIpfsStorage(gateway: string): FeedbackStorage {
  return {
    async store(feedback: OffChainFeedback): Promise<string> {
      const response = await fetch(`${gateway}/api/v0/add`, {
        method: 'POST',
        body: serializeFeedback(feedback),
      });

      if (!response.ok) {
        throw new Error(`Failed to store feedback to IPFS: ${response.statusText}`);
      }

      const result = IpfsStoreResponseSchema.parse(await response.json());
      return `ipfs://${result.Hash}`;
    },

    async retrieve(uri: string): Promise<OffChainFeedback | null> {
      try {
        let fetchUrl: string;
        if (uri.startsWith('ipfs://')) {
          const hash = uri.slice(7);
          fetchUrl = `${gateway}/ipfs/${hash}`;
        } else {
          fetchUrl = uri;
        }

        const response = await fetch(fetchUrl);
        if (!response.ok) {
          return null;
        }
        const json = await response.text();
        return deserializeFeedback(json);
      } catch {
        return null;
      }
    },
  };
}
