import type { KadDHT } from '@libp2p/kad-dht';
import { CID } from 'multiformats/cid';
import * as json from 'multiformats/codecs/json';
import { sha256 } from 'multiformats/hashes/sha2';
import type { EccoLibp2p } from './types';
import type { Capability, PeerInfo, CapabilityQuery } from '../types';
import { SDK_PROTOCOL_VERSION, formatProtocolVersion } from '../networks';
import { DHT } from './constants';

export type ReputationScorer = (peerId: string) => number;

type DHTCapableNode = {
  contentRouting: EccoLibp2p['contentRouting'];
  services: { dht?: KadDHT };
  getConnections: () => ReturnType<EccoLibp2p['getConnections']>;
};

const generateCapabilityKey = (capability: Partial<Capability>): string => {
  const type = capability.type || '*';
  const name = capability.name || '*';
  return `/ecco/capability/${type}/${name}`;
};

const keyToCID = async (key: string): Promise<CID> => {
  const bytes = new TextEncoder().encode(key);
  const hash = await sha256.digest(bytes);
  return CID.create(1, json.code, hash);
};

const isDHTReady = (node: DHTCapableNode, minPeers: number = 1): boolean => {
  if (!node.services.dht) {
    return false;
  }
  return node.getConnections().length >= minPeers;
};

const announceKey = async (node: DHTCapableNode, key: string): Promise<void> => {
  const cid = await keyToCID(key);
  await node.contentRouting.provide(cid);
};

export const announceCapabilities = async (
  node: DHTCapableNode,
  capabilities: Capability[],
  minPeers: number = 1
): Promise<{ announced: number; failed: number }> => {
  if (!isDHTReady(node, minPeers)) {
    return { announced: 0, failed: 0 };
  }

  const announcements = capabilities.flatMap((capability) => [
    announceKey(node, generateCapabilityKey(capability)),
    announceKey(node, generateCapabilityKey({ type: capability.type })),
  ]);

  const results = await Promise.allSettled(announcements);
  let announced = 0;
  let failed = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      announced++;
    } else {
      failed++;
      console.warn('[dht] Capability announcement failed:', result.reason);
    }
  }

  return { announced, failed };
};

const queryProviders = async (
  node: DHTCapableNode,
  cid: CID,
  capability: Partial<Capability>,
  discoveredPeers: Map<string, PeerInfo>,
  limit: number
): Promise<void> => {
  let providerCount = 0;
  for await (const provider of node.contentRouting.findProviders(cid)) {
    if (providerCount >= limit) {
      break;
    }
    providerCount++;

    const peerId = provider.id.toString();
    if (!provider.multiaddrs || provider.multiaddrs.length === 0) {
      continue;
    }
    const existing = discoveredPeers.get(peerId);

    const capabilityEntry: Capability = {
      type: capability.type ?? 'service',
      name: capability.name ?? 'unknown',
      version: capability.version ?? formatProtocolVersion(SDK_PROTOCOL_VERSION),
      ...(capability.metadata && { metadata: capability.metadata }),
    };

    if (existing) {
      const hasCapability = existing.capabilities.some(
        (c) => c.type === capabilityEntry.type && c.name === capabilityEntry.name
      );
      if (!hasCapability && existing.capabilities.length < DHT.MAX_CAPABILITIES_PER_PEER) {
        const updatedPeerInfo: PeerInfo = {
          ...existing,
          capabilities: [...existing.capabilities, capabilityEntry],
        };
        discoveredPeers.set(peerId, updatedPeerInfo);
      }
    } else {
      discoveredPeers.set(peerId, {
        id: peerId,
        addresses: provider.multiaddrs.map(String),
        capabilities: [capabilityEntry],
        lastSeen: Date.now(),
      });
    }
  }
};

export const queryCapabilities = async (
  node: DHTCapableNode,
  query: CapabilityQuery,
  getReputationScore?: ReputationScorer
): Promise<PeerInfo[]> => {
  const discoveredPeers = new Map<string, PeerInfo>();
  const limit = getReputationScore ? DHT.MAX_PROVIDERS_WITH_SCORER : DHT.MAX_PROVIDERS_DEFAULT;

  const queries = query.requiredCapabilities.map(async (requiredCap) => {
    const cid = await keyToCID(generateCapabilityKey(requiredCap));
    await queryProviders(node, cid, requiredCap, discoveredPeers, limit);
  });

  await Promise.allSettled(queries);

  const peers = Array.from(discoveredPeers.values());

  if (getReputationScore) {
    peers.sort((a, b) => getReputationScore(b.id) - getReputationScore(a.id));
  }

  return peers;
};
