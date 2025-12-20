import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generatePrivateKey } from 'viem/accounts';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import type { EccoConfig } from '../types';
import { z } from 'zod';

const PersistedKeyFileSchema = z.object({
  libp2pPrivateKey: z.string(),
  ethereumPrivateKey: z.string().startsWith('0x') as z.ZodType<`0x${string}`>,
});

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

export async function loadOrCreateNodeIdentity(config: EccoConfig): Promise<NodeIdentity> {
  const keyFilePath = resolveKeyPath(config);
  const exists = await fileExists(keyFilePath);

  if (exists) {
    const raw = await fs.readFile(keyFilePath, 'utf8');
    const result = PersistedKeyFileSchema.safeParse(JSON.parse(raw));

    if (!result.success) {
      throw new Error(`Invalid key file format at ${keyFilePath}: ${result.error.message}`);
    }

    const data = result.data;
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
  await fs.writeFile(keyFilePath, JSON.stringify(persist, null, 2), 'utf8');

  return {
    libp2pPrivateKey,
    ethereumPrivateKey,
    peerId: peerId.toString(),
    keyFilePath,
    created: true,
  };
}
