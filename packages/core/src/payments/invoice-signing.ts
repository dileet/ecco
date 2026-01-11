import type { PrivateKey, PublicKey } from '@libp2p/interface';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import type { Invoice, SignedInvoice } from '../types';
import { canonicalJsonStringify } from '../utils/canonical-json';
import { decodeBase64 } from '../utils/crypto';

const ED25519_SIGNATURE_LENGTH = 64;

function createInvoiceSignaturePayload(invoice: Invoice): Uint8Array {
  const payload = canonicalJsonStringify({
    id: invoice.id,
    jobId: invoice.jobId,
    chainId: invoice.chainId,
    amount: invoice.amount,
    token: invoice.token,
    recipient: invoice.recipient,
    validUntil: invoice.validUntil,
  });
  return new TextEncoder().encode(payload);
}

export async function signInvoice(
  privateKey: PrivateKey,
  invoice: Invoice
): Promise<SignedInvoice> {
  const data = createInvoiceSignaturePayload(invoice);
  const signature = await privateKey.sign(data);
  const publicKeyBytes = privateKey.publicKey.raw;

  return {
    ...invoice,
    signature: Buffer.from(signature).toString('base64'),
    publicKey: Buffer.from(publicKeyBytes).toString('base64'),
  };
}

export function isSignedInvoice(invoice: Invoice): invoice is SignedInvoice {
  return (
    typeof invoice.signature === 'string' &&
    invoice.signature.length > 0 &&
    typeof invoice.publicKey === 'string' &&
    invoice.publicKey.length > 0
  );
}

export async function verifyInvoice(
  invoice: SignedInvoice,
  keyCache?: Map<string, PublicKey>
): Promise<{ valid: boolean; keyCache?: Map<string, PublicKey> }> {
  try {
    let publicKey = keyCache?.get(invoice.publicKey);
    let newKeyCache = keyCache;

    if (!publicKey) {
      const publicKeyBytes = decodeBase64(invoice.publicKey);
      publicKey = publicKeyFromRaw(publicKeyBytes);
      if (keyCache) {
        newKeyCache = new Map(keyCache).set(invoice.publicKey, publicKey);
      }
    }

    const data = createInvoiceSignaturePayload(invoice);
    const signature = decodeBase64(invoice.signature);
    if (signature.length !== ED25519_SIGNATURE_LENGTH) {
      return { valid: false, keyCache: newKeyCache };
    }
    const isValid = await publicKey.verify(data, signature);

    return { valid: isValid, keyCache: newKeyCache };
  } catch {
    return { valid: false, keyCache };
  }
}
