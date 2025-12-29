import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { generatePrivateKey } from 'viem/accounts';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import type { EccoConfig } from '../types';
import { z } from 'zod';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

const PersistedKeyFileSchema = z.object({
  libp2pPrivateKey: z.string(),
  ethereumPrivateKey: z.string().startsWith('0x') as z.ZodType<`0x${string}`>,
});

const EncryptedKeyFileSchema = z.object({
  encrypted: z.literal(true),
  salt: z.string(),
  iv: z.string(),
  authTag: z.string(),
  data: z.string(),
});

type EncryptedKeyFile = z.infer<typeof EncryptedKeyFileSchema>;

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

function encryptData(plaintext: string, password: string): EncryptedKeyFile {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted: true,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptData(encryptedFile: EncryptedKeyFile, password: string): string {
  const salt = Buffer.from(encryptedFile.salt, 'base64');
  const iv = Buffer.from(encryptedFile.iv, 'base64');
  const authTag = Buffer.from(encryptedFile.authTag, 'base64');
  const encrypted = Buffer.from(encryptedFile.data, 'base64');

  if (salt.length !== SALT_LENGTH) {
    throw new Error('Invalid salt length');
  }
  if (iv.length !== IV_LENGTH) {
    throw new Error('Invalid IV length');
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Invalid auth tag length');
  }

  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

function getEncryptionPassword(config: EccoConfig): string | undefined {
  const configPassword = config.authentication?.keyPassword;
  if (configPassword && configPassword.length > 0) {
    return configPassword;
  }
  const envPassword = process.env['ECCO_KEY_PASSWORD'];
  if (envPassword && envPassword.length > 0) {
    return envPassword;
  }
  return undefined;
}

type PersistedKeyFile = z.infer<typeof PersistedKeyFileSchema>;

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

export interface NodeIdentity {
  libp2pPrivateKey: PrivateKey;
  ethereumPrivateKey: `0x${string}`;
  peerId: string;
  keyFilePath: string;
  created: boolean;
}

function parseKeyFileContent(raw: string, password: string | undefined): PersistedKeyFile {
  const parsed = JSON.parse(raw);

  const encryptedResult = EncryptedKeyFileSchema.safeParse(parsed);
  if (encryptedResult.success) {
    if (!password) {
      throw new Error('Key file is encrypted but no password provided. Set ECCO_KEY_PASSWORD environment variable or authentication.keyPassword in config.');
    }
    const decrypted = decryptData(encryptedResult.data, password);
    const decryptedParsed = JSON.parse(decrypted);
    const plaintextResult = PersistedKeyFileSchema.safeParse(decryptedParsed);
    if (!plaintextResult.success) {
      throw new Error(`Invalid decrypted key file format: ${plaintextResult.error.message}`);
    }
    return plaintextResult.data;
  }

  const plaintextResult = PersistedKeyFileSchema.safeParse(parsed);
  if (!plaintextResult.success) {
    throw new Error(`Invalid key file format: ${plaintextResult.error.message}`);
  }
  return plaintextResult.data;
}

export async function loadOrCreateNodeIdentity(config: EccoConfig): Promise<NodeIdentity> {
  const keyFilePath = resolveKeyPath(config);
  const exists = await fileExists(keyFilePath);
  const password = getEncryptionPassword(config);

  if (exists) {
    const raw = await fs.readFile(keyFilePath, 'utf8');
    const data = parseKeyFileContent(raw, password);

    const protobufBytes = Buffer.from(data.libp2pPrivateKey, 'base64');
    const libp2pPrivateKey = privateKeyFromProtobuf(protobufBytes);
    const peerId = peerIdFromPrivateKey(libp2pPrivateKey);

    return {
      libp2pPrivateKey,
      ethereumPrivateKey: data.ethereumPrivateKey,
      peerId: peerId.toString(),
      keyFilePath,
      created: false,
    };
  }

  const libp2pPrivateKey = await generateKeyPair('Ed25519');
  const ethereumPrivateKey = generatePrivateKey();
  const peerId = peerIdFromPrivateKey(libp2pPrivateKey);

  const persist: PersistedKeyFile = {
    libp2pPrivateKey: Buffer.from(privateKeyToProtobuf(libp2pPrivateKey)).toString('base64'),
    ethereumPrivateKey,
  };

  await ensureDir(path.dirname(keyFilePath));

  if (password) {
    const plaintext = JSON.stringify(persist);
    const encrypted = encryptData(plaintext, password);
    await fs.writeFile(keyFilePath, JSON.stringify(encrypted, null, 2), 'utf8');
  } else {
    await fs.writeFile(keyFilePath, JSON.stringify(persist, null, 2), 'utf8');
  }

  return {
    libp2pPrivateKey,
    ethereumPrivateKey,
    peerId: peerId.toString(),
    keyFilePath,
    created: true,
  };
}
