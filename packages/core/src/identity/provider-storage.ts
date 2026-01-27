import { z } from 'zod';

export const StorageProviderConfigSchema = z.object({
  uploadUrl: z.string().url(),
  headers: z.record(z.string()).optional(),
  responseField: z.string().min(1),
  uriPrefix: z.string().optional(),
  gateway: z.string().url().optional(),
  bodyField: z.string().min(1).optional(),
});

export type StorageProviderConfig = z.infer<typeof StorageProviderConfigSchema>;

export interface ProviderStorage<T> {
  store(data: T): Promise<string>;
  retrieve(uri: string): Promise<T | null>;
}

function resolveGatewayUrl(uri: string, gateway?: string): string | null {
  if (uri.startsWith('ipfs://')) {
    if (!gateway) {
      return null;
    }
    const cid = uri.slice(7);
    return `${gateway.replace(/\/$/, '')}/ipfs/${cid}`;
  }
  return uri;
}

function getResponseField(data: unknown, path: string): string {
  const parts = path.split('.').filter(Boolean);
  let current: unknown = data;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      throw new Error('Invalid response field');
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== 'string') {
    throw new Error('Response field is not a string');
  }
  return current;
}

export function createProviderStorage<T>(
  config: StorageProviderConfig,
  serialize: (data: T) => string,
  deserialize: (data: string) => T
): ProviderStorage<T> {
  const parsed = StorageProviderConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error('Invalid storage provider config');
  }

  const resolvedConfig = parsed.data;

  return {
    async store(data: T): Promise<string> {
      const serialized = serialize(data);
      const payload = resolvedConfig.bodyField
        ? JSON.stringify({ [resolvedConfig.bodyField]: JSON.parse(serialized) })
        : serialized;

      const response = await fetch(resolvedConfig.uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(resolvedConfig.headers ?? {}),
        },
        body: payload,
      });
      if (!response.ok) {
        throw new Error(`Failed to store data: ${response.statusText}`);
      }
      const result = await response.json();
      const fieldValue = getResponseField(result, resolvedConfig.responseField);
      const prefix = resolvedConfig.uriPrefix ?? '';
      return `${prefix}${fieldValue}`;
    },
    async retrieve(uri: string): Promise<T | null> {
      const fetchUrl = resolveGatewayUrl(uri, resolvedConfig.gateway);
      if (!fetchUrl) {
        return null;
      }
      try {
        const response = await fetch(fetchUrl);
        if (!response.ok) {
          return null;
        }
        const json = await response.text();
        return deserialize(json);
      } catch {
        return null;
      }
    },
  };
}
