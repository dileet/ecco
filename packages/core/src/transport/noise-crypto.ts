import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { extract, expand } from '@noble/hashes/hkdf.js';

interface Uint8ArrayLike {
  subarray(): Uint8Array;
}

type DataInput = Uint8Array | Uint8ArrayLike;

function toBytes(data: DataInput): Uint8Array {
  if ('subarray' in data && typeof data.subarray === 'function') {
    return data.subarray();
  }
  return data as Uint8Array;
}

export const pureJsCrypto = {
  hashSHA256(data: DataInput): Uint8Array {
    return sha256(toBytes(data));
  },

  getHKDF(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
    const prk = extract(sha256, ikm, ck);
    const okm = expand(sha256, prk, undefined, 96);
    return [
      okm.subarray(0, 32),
      okm.subarray(32, 64),
      okm.subarray(64, 96),
    ];
  },

  generateX25519KeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
    const secretKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(secretKey);
    return { publicKey, privateKey: secretKey };
  },

  generateX25519KeyPairFromSeed(seed: Uint8Array): { publicKey: Uint8Array; privateKey: Uint8Array } {
    const publicKey = x25519.getPublicKey(seed);
    return { publicKey, privateKey: seed };
  },

  generateX25519SharedKey(privateKey: DataInput, publicKey: DataInput): Uint8Array {
    return x25519.getSharedSecret(toBytes(privateKey), toBytes(publicKey));
  },

  chaCha20Poly1305Encrypt(
    plaintext: DataInput,
    nonce: Uint8Array,
    ad: Uint8Array,
    k: Uint8Array
  ): Uint8Array {
    return chacha20poly1305(k, nonce, ad).encrypt(toBytes(plaintext));
  },

  chaCha20Poly1305Decrypt(
    ciphertext: DataInput,
    nonce: Uint8Array,
    ad: Uint8Array,
    k: Uint8Array,
    dst?: Uint8Array
  ): Uint8Array {
    return chacha20poly1305(k, nonce, ad).decrypt(toBytes(ciphertext), dst);
  },
};

