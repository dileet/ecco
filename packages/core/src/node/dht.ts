import type { KadDHT } from '@libp2p/kad-dht';
import { CID } from 'multiformats/cid';
import * as json from 'multiformats/codecs/json';
import { sha256 } from 'multiformats/hashes/sha2';
import type { EccoLibp2p } from './types';
import type { Capability, PeerInfo, CapabilityQuery } from '../types';
import { SDK_PROTOCOL_VERSION, formatProtocolVersion } from '../networks';

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
): Promise<void> => {
  if (!isDHTReady(node, minPeers)) {
    return;
  }

  const announcements = capabilities.flatMap((capability) => [
    announceKey(node, generateCapabilityKey(capability)),
    announceKey(node, generateCapabilityKey({ type: capability.type })),
  ]);

  await Promise.allSettled(announcements);
};

const queryProviders = async (
  node: DHTCapableNode,
  cid: CID,
  capability: Partial<Capability>,
  discoveredPeers: Map<string, PeerInfo>
): Promise<void> => {
  for await (const provider of node.contentRouting.findProviders(cid)) {
    const peerId = provider.id.toString();
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
      if (!hasCapability) {
        existing.capabilities.push(capabilityEntry);
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
  query: CapabilityQuery
): Promise<PeerInfo[]> => {
  const discoveredPeers = new Map<string, PeerInfo>();

  const queries = query.requiredCapabilities.map(async (requiredCap) => {
    const cid = await keyToCID(generateCapabilityKey(requiredCap));
    await queryProviders(node, cid, requiredCap, discoveredPeers);
  });

  await Promise.allSettled(queries);

  return Array.from(discoveredPeers.values());
};
