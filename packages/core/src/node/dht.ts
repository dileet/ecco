import { Effect } from 'effect';
import type { KadDHT } from '@libp2p/kad-dht';
import { CID } from 'multiformats/cid';
import * as json from 'multiformats/codecs/json';
import { sha256 } from 'multiformats/hashes/sha2';
import type { NodeState, EccoLibp2p } from './types';
import type { Capability, PeerInfo, CapabilityQuery } from '../types';
import { Matcher } from '../capability-matcher';

type DHTCapableNode = {
  contentRouting: EccoLibp2p['contentRouting'];
  services: { dht?: KadDHT };
  getConnections: () => ReturnType<EccoLibp2p['getConnections']>;
};

export namespace DHT {
  export function generateCapabilityKey(capability: Partial<Capability>): string {
    const type = capability.type || '*';
    const name = capability.name || '*';
    return `/ecco/capability/${type}/${name}`;
  }

  export function generatePeerKey(peerId: string): string {
    return `/ecco/peer/${peerId}`;
  }

  async function keyToCID(key: string): Promise<CID> {
    const bytes = new TextEncoder().encode(key);
    const hash = await sha256.digest(bytes);
    return CID.create(1, json.code, hash);
  }

  export async function isDHTReady(node: DHTCapableNode, minPeers: number = 1): Promise<boolean> {
    if (!node.services.dht) {
      return false;
    }

    const connections = node.getConnections();
    const connectedPeers = connections.length;

    return connectedPeers >= minPeers;
  }

  export async function waitForDHTReady(
    node: DHTCapableNode,
    minPeers: number = 1,
    timeout: number = 10000,
    checkInterval: number = 500
  ): Promise<boolean> {
    const startTime = Date.now();
    console.log(`[DHT] Waiting for at least ${minPeers} peer(s) (timeout ${timeout}ms)`);

    while (Date.now() - startTime < timeout) {
      if (await isDHTReady(node, minPeers)) {
        console.log('[DHT] DHT is ready');
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    console.warn('[DHT] Timeout waiting for DHT to be ready');
    return false;
  }

  async function announceWithTimeout(
    node: DHTCapableNode,
    cid: CID,
    key: string,
    timeout: number = 10000
  ): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      console.log(`[DHT] Calling contentRouting.provide() for ${key}, CID: ${cid.toString()}`);
      await node.contentRouting.provide(cid, { signal: controller.signal });
      console.log(`[DHT] Successfully announced: ${key}`);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`DHT announcement timeout for ${key}`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  export async function announceCapabilities(
    node: DHTCapableNode,
    nodeId: string,
    capabilities: Capability[],
    addresses: string[],
    options: {
      waitForReady?: boolean;
      minPeers?: number;
      timeout?: number;
      retries?: number;
    } = {}
  ): Promise<void> {
    const {
      waitForReady = true,
      minPeers = 1,
      timeout = 10000,
      retries = 2,
    } = options;

    console.log(`[DHT] Announcing ${capabilities.length} capabilities`);

    // Check if DHT is ready
    if (waitForReady) {
      const isReady = await waitForDHTReady(node, minPeers, timeout);
      if (!isReady) {
        console.warn('[DHT] DHT not ready, skipping announcement');
        return;
      }
    }

    const announcements = capabilities.flatMap((capability) => {
      const keys = [
        generateCapabilityKey(capability), // Specific: /ecco/capability/agent/gpt-4
        generateCapabilityKey({ type: capability.type }), // General: /ecco/capability/agent/*
      ];

      return keys.map(async (key) => {
        const cid = await keyToCID(key);

        let lastError: Error | null = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            if (attempt > 0) {
              console.log(`[DHT] Retry ${attempt}/${retries} for ${key}`);
              await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }

            await announceWithTimeout(node, cid, key, timeout);
            return;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.warn(`[DHT] Attempt ${attempt + 1} failed for ${key}: ${lastError.message}`);
          }
        }

        console.error(`[DHT] Failed to announce ${key} after ${retries + 1} attempts:`, lastError);
      });
    });

    try {
      await Promise.allSettled(announcements);
      console.log('[DHT] Announcement complete');
    } catch (error) {
      console.error('[DHT] Error announcing capabilities:', error);
      throw error;
    }
  }

  async function queryWithTimeout(
    node: DHTCapableNode,
    cid: CID,
    discoveredPeers: Map<string, PeerInfo>,
    timeout: number
  ): Promise<void> {
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('DHT query timeout')), timeout);
    });

    const queryPromise = new Promise<void>(async (resolve) => {
      try {
        console.log(`[DHT] Calling contentRouting.findProviders() for CID: ${cid.toString()}`);
        let providerCount = 0;
        // Use contentRouting.findProviders() to find all peers providing this capability
        for await (const provider of node.contentRouting.findProviders(cid, { signal: AbortSignal.timeout(timeout) })) {
          providerCount++;
          const peerId = provider.id.toString();
          const addresses = provider.multiaddrs.map(String);

          console.log(`[DHT] Provider #${providerCount}: ${peerId}, addresses: ${addresses.length}`);

          // Create a minimal PeerInfo from the provider data
          // We'll need to get full capability info from the peer later
          const peerInfo: PeerInfo = {
            id: peerId,
            addresses,
            capabilities: [],
            lastSeen: Date.now(),
          };

          discoveredPeers.set(peerId, peerInfo);
          console.log(`[DHT] Found peer ${peerId}`);
        }
        console.log(`[DHT] findProviders iteration complete, found ${providerCount} providers`);
      } catch (error) {
        // Timeout or other error
        console.error('[DHT] Provider search error:', error);
        if (error instanceof Error) {
          console.error(`[DHT] Error message: ${error.message}`);
        }
      }
      resolve();
    });

    await Promise.race([queryPromise, timeoutPromise]).catch(() => {
      // Timeout is expected, just log and continue
    });
  }

  export async function queryCapabilities(
    node: DHTCapableNode,
    query: CapabilityQuery,
    _matcherState: ReturnType<typeof Matcher.create>,
    timeout: number = 5000
  ): Promise<PeerInfo[]> {
    console.log('[DHT] Querying capabilities...', query);

    const discoveredPeers = new Map<string, PeerInfo>();

    const queries = query.requiredCapabilities.map(async (requiredCap) => {
      const key = generateCapabilityKey(requiredCap);
      const cid = await keyToCID(key);

      try {
        await queryWithTimeout(node, cid, discoveredPeers, timeout);
      } catch (error) {
        if (error instanceof Error && error.message !== 'DHT query timeout') {
          console.warn(`[DHT] Query failed for ${key}:`, error);
        }
      }
    });

    await Promise.allSettled(queries);

    const peers = Array.from(discoveredPeers.values());
    console.log(`[DHT] Found ${peers.length} peers`);
    return peers;
  }

  async function getPeerInfoFromDHT(dht: KadDHT, cid: CID): Promise<PeerInfo | null> {
    for await (const event of dht.get(cid.bytes)) {
      if (event.name === 'VALUE') {
        const peerInfoStr = new TextDecoder().decode(event.value);
        return JSON.parse(peerInfoStr);
      }
    }
    return null;
  }

  export async function putJSON(dht: KadDHT, key: string, value: unknown): Promise<void> {
    const cid = await keyToCID(key);
    const data = new TextEncoder().encode(JSON.stringify(value));
    await dht.put(cid.bytes, data);
  }

  export async function getJSON(dht: KadDHT, key: string): Promise<unknown | null> {
    const cid = await keyToCID(key);
    for await (const event of dht.get(cid.bytes)) {
      if (event.name === 'VALUE') {
        try {
          return JSON.parse(new TextDecoder().decode(event.value));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  export async function getPeerInfo(
    dht: KadDHT,
    peerId: string,
    timeout: number = 3000
  ): Promise<PeerInfo | null> {
    try {
      const key = generatePeerKey(peerId);
      const cid = await keyToCID(key);

      const timeoutPromise = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeout);
      });

      const queryPromise = getPeerInfoFromDHT(dht, cid);

      return await Promise.race([queryPromise, timeoutPromise]);
    } catch (error) {
      console.warn(`[DHT] Failed to get peer info for ${peerId}:`, error);
      return null;
    }
  }

  export function startPeriodicAnnouncement(
    node: EccoLibp2p,
    nodeId: string,
    getCapabilities: () => Capability[],
    getAddresses: () => string[],
    intervalMs: number = 300000
  ): () => void {
    console.log(`[DHT] Starting periodic announcements every ${intervalMs}ms`);

    const announce = async () => {
      try {
        const capabilities = getCapabilities();
        const addresses = getAddresses();
        await announceCapabilities(node, nodeId, capabilities, addresses, {
          waitForReady: true,
          minPeers: 1,
          timeout: 10000,
          retries: 2,
        });
      } catch (error) {
        console.error('[DHT] Periodic announcement failed:', error);
      }
    };

    announce();

    const intervalId = setInterval(announce, intervalMs);

    return () => {
      console.log('[DHT] Stopping periodic announcements');
      clearInterval(intervalId);
    };
  }

  export function announceCapabilitiesEffect(
    state: NodeState,
    options?: {
      waitForReady?: boolean;
      minPeers?: number;
      timeout?: number;
      retries?: number;
    }
  ): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: async () => {
        if (!state.node) {
          throw new Error('Node not available');
        }
        if (!state.node.services.dht) {
          throw new Error('DHT service not available');
        }

        const addresses = state.node.getMultiaddrs().map(String);
        await announceCapabilities(state.node, state.id, state.capabilities, addresses, options);
      },
      catch: (error) => {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return new Error(`DHT announcement failed: ${message}`);
      },
    });
  }

  export function queryCapabilitiesEffect(
    state: NodeState,
    query: CapabilityQuery,
    timeout?: number
  ): Effect.Effect<PeerInfo[], Error> {
    return Effect.tryPromise({
      try: async () => {
        if (!state.node) {
          throw new Error('Node not available');
        }
        if (!state.node.services.dht) {
          throw new Error('DHT service not available');
        }

        return await queryCapabilities(state.node, query, state.capabilityMatcher, timeout);
      },
      catch: (error) => {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return new Error(`DHT query failed: ${message}`);
      },
    });
  }
}
