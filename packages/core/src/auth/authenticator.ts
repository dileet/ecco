import type { PrivateKey, PublicKey } from '@libp2p/interface';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { z } from 'zod';
import type { Message } from '../types';
import { canonicalJsonStringify } from '../utils/canonical-json';
import { decodeBase64 } from '../utils/crypto';
import type { LRUCache } from '../utils/lru-cache';
import { createLRUCache, cloneLRUCache } from '../utils/lru-cache';
import { debug } from '../utils';
import { AUTH } from './constants';

const MessagePayloadSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  type: z.string(),
  payload: z.unknown(),
  timestamp: z.number(),
});

const SignedMessageSchema = MessagePayloadSchema.extend({
  signature: z.string().min(1),
  publicKey: z.string().min(1),
});

export interface AuthConfig {
  enabled: boolean;
  privateKey?: PrivateKey;
}

export interface SignedMessage extends Message {
  signature: string;
  publicKey: string;
}

export interface AuthState {
  config: AuthConfig;
  keyCache: LRUCache<string, PublicKey>;
}

const ED25519_SIGNATURE_LENGTH = 64;

export function createPublicKeyCache(): LRUCache<string, PublicKey> {
  return createLRUCache<string, PublicKey>(AUTH.MAX_PUBLIC_KEY_CACHE_SIZE);
}

function createSignaturePayload(message: z.infer<typeof MessagePayloadSchema>): Uint8Array {
  const payload = canonicalJsonStringify({
    id: message.id,
    from: message.from,
    to: message.to,
    type: message.type,
    payload: message.payload,
    timestamp: message.timestamp,
  });
  return new TextEncoder().encode(payload);
}

export async function signMessage(state: AuthState, message: Message): Promise<SignedMessage> {
  if (!state.config.enabled || !state.config.privateKey) {
    throw new Error('Authentication not enabled or keys not configured');
  }

  const data = createSignaturePayload(message);
  debug('auth', `Signing ${message.type} from ${message.from}`);
  debug('auth', `Sign payload: ${new TextDecoder().decode(data)}`);
  const signature = await state.config.privateKey.sign(data);
  const publicKeyBytes = state.config.privateKey.publicKey.raw;

  return {
    ...message,
    signature: Buffer.from(signature).toString('base64'),
    publicKey: Buffer.from(publicKeyBytes).toString('base64'),
  };
}

export async function verifyMessage(
  state: AuthState,
  signedMessage: z.infer<typeof SignedMessageSchema>
): Promise<{ valid: boolean; state: AuthState }> {
  if (!state.config.enabled) {
    return { valid: true, state };
  }

  const parsed = SignedMessageSchema.safeParse(signedMessage);
  if (!parsed.success) {
    return { valid: false, state };
  }

  try {
    let publicKey = state.keyCache.get(signedMessage.publicKey);
    let newState = state;

    if (!publicKey) {
      const publicKeyBytes = decodeBase64(signedMessage.publicKey);
      publicKey = publicKeyFromRaw(publicKeyBytes);
      const newCache = cloneLRUCache(state.keyCache);
      newCache.set(signedMessage.publicKey, publicKey);
      newState = {
        ...state,
        keyCache: newCache,
      };
    }

    const derivedPeerId = peerIdFromPublicKey(publicKey);
    if (derivedPeerId.toString().toLowerCase() !== signedMessage.from.toLowerCase()) {
      debug('auth', `PeerId mismatch: derived=${derivedPeerId.toString()}, from=${signedMessage.from}`);
      return { valid: false, state: newState };
    }

    const data = createSignaturePayload(signedMessage);
    const signature = decodeBase64(signedMessage.signature);
    if (signature.length !== ED25519_SIGNATURE_LENGTH) {
      debug('auth', `Signature length invalid: ${signature.length} !== ${ED25519_SIGNATURE_LENGTH}`);
      return { valid: false, state: newState };
    }
    const isValid = await publicKey.verify(data, signature);

    if (!isValid) {
      debug('auth', `Signature verification failed for ${signedMessage.type} from ${signedMessage.from}`);
      debug('auth', `Verify payload: ${new TextDecoder().decode(data)}`);
    }

    return { valid: isValid, state: newState };
  } catch (error) {
    console.error('Message verification failed:', error);
    return { valid: false, state };
  }
}

export function isMessageFresh(
  message: Message,
  maxAgeMs: number = 60000,
  clockSkewToleranceMs: number = 5000
): boolean {
  const now = Date.now();
  const age = now - message.timestamp;
  return age >= -clockSkewToleranceMs && age <= maxAgeMs;
}

