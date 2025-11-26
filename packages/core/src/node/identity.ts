import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generatePrivateKey } from 'viem/accounts';
import { importPrivateKey, importPublicKey, generateKeyPair, exportPrivateKey, exportPublicKey } from '../services/auth';
import type { EccoConfig } from '../types';
import { z } from 'zod';

const PersistedKeyFileSchema = z.object({
  algorithm: z.literal('ECDSA-P-256'),
  privateKey: z.string(),
  publicKey: z.string(),
  ethereumPrivateKey: z.string().startsWith('0x').optional() as z.ZodType<`0x${string}` | undefined>,
});

function toBase64Url(input: Uint8Array): string {
  const base64 = Buffer.from(input).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function computePublicKeyFingerprint(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  const digest = await crypto.subtle.digest('SHA-256', spki);
  return toBase64Url(new Uint8Array(digest));
}

function resolveKeyPath(config: EccoConfig): string {
  const configuredPath = config.authentication?.['keyPath'];
  if (configuredPath && configuredPath.length > 0) {
    return path.isAbsolute(configuredPath)
      ? configuredPath
      : path.join(process.cwd(), configuredPath);
  }
  const nodeIdPart = config.nodeId && config.nodeId.length > 0 ? config.nodeId : 'default';
  const home = os.homedir();
  return path.join(home, '.ecco', 'identity', `${nodeIdPart}.json`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function loadOrCreateNodeIdentity(config: EccoConfig): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  ethereumPrivateKey?: `0x${string}`;
  nodeIdFromKeys: string;
  keyFilePath: string;
  created: boolean;
}> {
  const keyFilePath = resolveKeyPath(config);
  const exists = await fileExists(keyFilePath);

  if (exists) {
    const raw = await fs.readFile(keyFilePath, 'utf8');
    const result = PersistedKeyFileSchema.safeParse(JSON.parse(raw));
    
    if (!result.success) {
      throw new Error(`Invalid key file format at ${keyFilePath}: ${result.error.message}`);
    }
    
    const parsed = result.data;
    const privateKey = await importPrivateKey(parsed.privateKey);
    const publicKey = await importPublicKey(parsed.publicKey);
    const fingerprint = await computePublicKeyFingerprint(publicKey);
    
    let ethereumPrivateKey = parsed.ethereumPrivateKey;
    if (!ethereumPrivateKey) {
      ethereumPrivateKey = generatePrivateKey();
      const updatedPersist = {
        ...parsed,
        ethereumPrivateKey,
      };
      await fs.writeFile(keyFilePath, JSON.stringify(updatedPersist), 'utf8');
    }
    
    return {
      privateKey,
      publicKey,
      ethereumPrivateKey,
      nodeIdFromKeys: `pk-${fingerprint}`,
      keyFilePath,
      created: false,
    };
  }

  if (config.authentication?.generateKeys === false) {
    throw new Error('Authentication generateKeys=false and no key file present');
  }

  const { privateKey, publicKey } = await generateKeyPair();
  const privateKeyStr = await exportPrivateKey(privateKey);
  const publicKeyStr = await exportPublicKey(publicKey);
  const ethereumPrivateKey = generatePrivateKey();
  const persist: PersistedKeyFile = {
    algorithm: 'ECDSA-P-256',
    privateKey: privateKeyStr,
    publicKey: publicKeyStr,
    ethereumPrivateKey,
  };
  await ensureDir(path.dirname(keyFilePath));
  await fs.writeFile(keyFilePath, JSON.stringify(persist), 'utf8');

  const fingerprint = await computePublicKeyFingerprint(publicKey);
  return {
    privateKey,
    publicKey,
    ethereumPrivateKey,
    nodeIdFromKeys: `pk-${fingerprint}`,
    keyFilePath,
    created: true,
  };
}


