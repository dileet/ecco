import type { PrivateKey, PublicKey } from '@libp2p/interface';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import type { Message } from '../types';

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
  keyCache: Map<string, PublicKey>;
}

function createSignaturePayload(message: Message | SignedMessage): Uint8Array {
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
  signedMessage: SignedMessage
): Promise<{ valid: boolean; state: AuthState }> {
  if (!state.config.enabled) {
    return { valid: true, state };
  }

  try {
    let publicKey = state.keyCache.get(signedMessage.publicKey);
    let newState = state;

    if (!publicKey) {
      const publicKeyBytes = Buffer.from(signedMessage.publicKey, 'base64');
      publicKey = publicKeyFromRaw(publicKeyBytes);
      newState = {
        ...state,
        keyCache: new Map(state.keyCache).set(signedMessage.publicKey, publicKey),
      };
    }

    const derivedPeerId = peerIdFromPublicKey(publicKey);
    if (derivedPeerId.toString() !== signedMessage.from) {
      return { valid: false, state: newState };
    }

    const data = createSignaturePayload(signedMessage);
    const signature = Buffer.from(signedMessage.signature, 'base64');
    const isValid = await publicKey.verify(data, signature);

    return { valid: isValid, state: newState };
  } catch (error) {
    console.error('Message verification failed:', error);
    return { valid: false, state };
  }
}

export function isMessageFresh(message: Message, maxAgeMs: number = 60000): boolean {
  const now = Date.now();
  const age = now - message.timestamp;
  return age >= 0 && age <= maxAgeMs;
}

function canonicalJsonStringify(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJsonStringify(item));
    return '[' + items.join(',') + ']';
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = keys.map((key) => {
      const v = (value as Record<string, unknown>)[key];
      return JSON.stringify(key) + ':' + canonicalJsonStringify(v);
    });
    return '{' + pairs.join(',') + '}';
  }

  return 'null';
}
