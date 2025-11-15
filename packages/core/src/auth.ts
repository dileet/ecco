import type { Message } from './types';

export interface AuthConfig {
  enabled: boolean;
  privateKey?: CryptoKey;
  publicKey?: CryptoKey;
}

export interface SignedMessage extends Message {
  signature: string;
  publicKey: string;
}

export interface AuthState {
  config: AuthConfig;
  keyCache: Map<string, CryptoKey>;
}

export namespace Auth {
  export async function generateKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      throw new Error('Web Crypto API not available');
    }

    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      true,
      ['sign', 'verify']
    );

    return {
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
    };
  }

  export async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
    const exported = await crypto.subtle.exportKey('spki', publicKey);
    const base64 = Buffer.from(exported).toString('base64');
    return base64;
  }

  export async function importPublicKey(publicKeyStr: string): Promise<CryptoKey> {
    const buffer = Buffer.from(publicKeyStr, 'base64');
    return crypto.subtle.importKey(
      'spki',
      buffer,
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      true,
      ['verify']
    );
  }

  export async function exportPrivateKey(privateKey: CryptoKey): Promise<string> {
    const exported = await crypto.subtle.exportKey('pkcs8', privateKey);
    const base64 = Buffer.from(exported).toString('base64');
    return base64;
  }

  export async function importPrivateKey(privateKeyStr: string): Promise<CryptoKey> {
    const buffer = Buffer.from(privateKeyStr, 'base64');
    return crypto.subtle.importKey(
      'pkcs8',
      buffer,
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      true,
      ['sign']
    );
  }

  export function create(config: AuthConfig): AuthState {
    return {
      config,
      keyCache: new Map(),
    };
  }

  export async function sign(state: AuthState, message: Message): Promise<SignedMessage> {
    if (!state.config.enabled || !state.config.privateKey || !state.config.publicKey) {
      throw new Error('Authentication not enabled or keys not configured');
    }

    const payload = createSignaturePayload(message);
    const encoder = new TextEncoder();
    const data = encoder.encode(payload);

    const signature = await crypto.subtle.sign(
      {
        name: 'ECDSA',
        hash: { name: 'SHA-256' },
      },
      state.config.privateKey,
      data
    );

    const publicKeyStr = await exportPublicKey(state.config.publicKey);

    return {
      ...message,
      signature: Buffer.from(signature).toString('base64'),
      publicKey: publicKeyStr,
    };
  }

  export async function verify(
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
        publicKey = await importPublicKey(signedMessage.publicKey);
        newState = {
          ...state,
          keyCache: new Map(state.keyCache).set(signedMessage.publicKey, publicKey),
        };
      }

      const payload = createSignaturePayload(signedMessage);
      const encoder = new TextEncoder();
      const data = encoder.encode(payload);

      const signature = Buffer.from(signedMessage.signature, 'base64');
      const isValid = await crypto.subtle.verify(
        {
          name: 'ECDSA',
          hash: { name: 'SHA-256' },
        },
        publicKey,
        signature,
        data
      );

      return { valid: isValid, state: newState };
    } catch (error) {
      console.error('Message verification failed:', error);
      return { valid: false, state };
    }
  }

  function createSignaturePayload(message: Message | SignedMessage): string {
    return JSON.stringify({
      id: message.id,
      from: message.from,
      to: message.to,
      type: message.type,
      payload: message.payload,
      timestamp: message.timestamp,
    });
  }

  export function isMessageFresh(message: Message, maxAgeMs: number = 60000): boolean {
    const now = Date.now();
    const age = now - message.timestamp;
    return age >= 0 && age <= maxAgeMs;
  }

  export function clearCache(state: AuthState): AuthState {
    return {
      ...state,
      keyCache: new Map(),
    };
  }
}
