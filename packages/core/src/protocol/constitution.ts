import type {
  Message,
  Constitution,
  ConstitutionHash,
  ConstitutionMismatchNotice,
} from '../types';

export async function computeConstitutionHash(constitution: Constitution): Promise<ConstitutionHash> {
  const joined = constitution.rules.join('\n').normalize('NFC');
  const encoder = new TextEncoder();
  const data = encoder.encode(joined);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toLowerCase();

  return {
    hash,
    rulesCount: constitution.rules.length,
  };
}

function safeHashSlice(hash: string, length: number): string {
  if (hash.length < length) {
    return hash;
  }
  return hash.slice(0, length);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ a.charCodeAt(i);
    }
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function validateConstitution(
  localHash: ConstitutionHash,
  peerHash: ConstitutionHash
): { valid: boolean; reason?: string } {
  const localNormalized = localHash.hash.toLowerCase();
  const peerNormalized = peerHash.hash.toLowerCase();

  if (!timingSafeEqual(localNormalized, peerNormalized)) {
    return {
      valid: false,
      reason: `Constitution mismatch: expected hash ${safeHashSlice(localNormalized, 16)}..., received ${safeHashSlice(peerNormalized, 16)}...`,
    };
  }

  return { valid: true };
}

export function createConstitutionMismatchNotice(
  fromPeerId: string,
  toPeerId: string,
  expectedHash: string,
  receivedHash: string
): Message {
  const expectedNormalized = expectedHash.toLowerCase();
  const receivedNormalized = receivedHash.toLowerCase();

  const payload: ConstitutionMismatchNotice = {
    expectedHash: expectedNormalized,
    receivedHash: receivedNormalized,
    message: `Constitution mismatch: this network requires all agents to share the same constitution. Expected hash ${safeHashSlice(expectedNormalized, 16)}..., received ${safeHashSlice(receivedNormalized, 16)}...`,
  };

  return {
    id: crypto.randomUUID(),
    from: fromPeerId,
    to: toPeerId,
    type: 'constitution-mismatch-notice',
    payload,
    timestamp: Date.now(),
  };
}

export function parseConstitutionHash(payload: unknown): ConstitutionHash | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const p = payload as Record<string, unknown>;

  if (typeof p.hash !== 'string' || typeof p.rulesCount !== 'number') {
    return null;
  }

  return {
    hash: p.hash,
    rulesCount: p.rulesCount,
  };
}

export function formatConstitutionForSystemPrompt(constitution: Constitution): string {
  if (constitution.rules.length === 0) {
    return '';
  }

  const numberedRules = constitution.rules
    .map((rule, index) => `${index + 1}. ${rule}`)
    .join('\n');

  return `# Constitutional Rules
You must adhere to the following rules:
${numberedRules}

`;
}
