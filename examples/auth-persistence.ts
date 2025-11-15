/**
 * Example: Authentication Key Persistence + Performance Tracking
 *
 * - Verifies that enabling authentication with a fixed keyPath preserves the node's identity across restarts.
 * - Demonstrates how to view peer service counters by running a minimal local embedding exchange between two nodes.
 *
 * Run:
 *   bun run examples/auth-persistence.ts
 */
import { Node, EventBus, EmbeddingService, isEmbeddingRequest, getState, addPeerRef, type NodeState } from '@ecco/core';
import { Effect, Ref } from 'effect';
import { promises as fs } from 'fs';

const KEY_PATH = '.keys/auth-persistence-node.json';
const PROVIDER_KEY_PATH = '.keys/auth-provider.json';
const SEEKER_KEY_PATH = '.keys/auth-seeker.json';

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}


async function printPeers(state: NodeState, label: string) {
  const live = state._ref ? await Effect.runPromise(getState(state._ref)) : state;
  const peers = Node.getPeers(live);
  console.log(`\n[${label}] Peers: ${peers.length}`);
  for (const peer of peers) {
    const balance = (peer.servicesProvided || 0) - (peer.servicesConsumed || 0);
    console.log(
      `  - ${peer.id} | provided=${peer.servicesProvided || 0} | consumed=${peer.servicesConsumed || 0} | balance=${balance}`
    );
  }
}

function createDummyEmbedding(text: string): number[] {
  const len = text.length;
  let sum = 0;
  let vowels = 0;
  for (const ch of text.toLowerCase()) {
    const code = ch.charCodeAt(0);
    sum += isFinite(code) ? code : 0;
    if ('aeiou'.includes(ch)) vowels++;
  }
  return [len, sum, vowels, 1];
}

async function createEmbeddingProviderNode(): Promise<NodeState> {
  let provider = Node.create({
    discovery: ['mdns', 'gossip'],
    authentication: {
      enabled: true,
      keyPath: PROVIDER_KEY_PATH,
    },
    capabilities: [
      {
        type: 'embedding',
        name: 'text-embedding',
        version: '1.0.0',
        metadata: {
          provider: 'dummy',
          model: 'dummy',
          dimensions: 4,
        },
      },
    ],
  });
  provider = await Node.start(provider);

  Node.subscribeToTopic(provider, `peer:${Node.getId(provider)}`, async (event) => {
    if (event.type !== 'message') return;
    if (!isEmbeddingRequest(event.payload)) return;
    try {
      const { requestId, texts } = event.payload;

      // Ensure provider has a peer record for the requester
      if (provider._ref) {
        const current = await Effect.runPromise(getState(provider._ref));
        if (!current.peers.get(event.from)) {
          await Effect.runPromise(addPeerRef(provider._ref, {
            id: event.from,
            addresses: [],
            capabilities: [],
            lastSeen: Date.now(),
          }));
        }
      }

      const embeddings = texts.map(createDummyEmbedding);
      const response = {
        type: 'embedding-response' as const,
        requestId,
        embeddings,
        model: 'dummy',
        dimensions: 4,
      };
      const responseEvent = EventBus.createMessage(Node.getId(provider), event.from, response);
      // Publish on both an ephemeral response topic and the seeker's peer topic to avoid
      // race conditions with topic subscription propagation.
      await Node.publish(provider, `embedding-response:${requestId}`, responseEvent);
      await Node.publish(provider, `peer:${event.from}`, responseEvent);

      const liveProvider = provider._ref ? await Effect.runPromise(getState(provider._ref)) : provider;
      const updatedProvider = EmbeddingService.updatePeerServiceProvided(liveProvider, event.from);
      if (provider._ref) {
        const nextProvider: NodeState = { ...updatedProvider, _ref: provider._ref };
        await Effect.runPromise(Ref.set(provider._ref, nextProvider));
        provider = nextProvider;
      } else {
        provider = updatedProvider;
      }
      console.log(`[provider] served ${texts.length} embeddings to ${event.from}`);
    } catch (err) {
      console.error('[provider] error handling embedding request:', err);
    }
  });

  console.log('[provider] started');
  return provider;
}

async function requestDummyEmbeddings(seeker: NodeState, preferredPeerId: string): Promise<void> {
  try {
    const result = await Effect.runPromise(
      EmbeddingService.requestEmbeddings(seeker, ['hello world', 'identity persistence'], { model: 'dummy', preferredPeers: [preferredPeerId] })
    );
    if (seeker._ref) {
      await Effect.runPromise(Ref.set(seeker._ref, { ...result.state, _ref: seeker._ref }));
    }
    console.log(`[seeker] received ${result.embeddings.length} embeddings`);
  } catch (err) {
    console.log('[seeker] embedding request failed:', (err as Error).message);
  }
}

async function main() {
  console.log('=== Auth Persistence Test ===\n');
  console.log(`Key file path: ${KEY_PATH}\n`);

  // First start: generate or load keys, then stop
  let nodeA = Node.create({
    discovery: ['mdns', 'gossip'],
    authentication: {
      enabled: true,
      keyPath: KEY_PATH,
    },
  });
  nodeA = await Node.start(nodeA);
  const firstId = Node.getId(nodeA);
  console.log(`First start Node ID: ${firstId}`);
  console.log(`Key file exists after first start: ${await fileExists(KEY_PATH)}\n`);
  await Node.stop(nodeA);

  // Second start: load the same keys and confirm the ID matches
  let nodeB = Node.create({
    discovery: ['mdns', 'gossip'],
    authentication: {
      enabled: true,
      keyPath: KEY_PATH,
    },
  });
  nodeB = await Node.start(nodeB);
  const secondId = Node.getId(nodeB);
  console.log(`Second start Node ID: ${secondId}`);
  console.log(`IDs match: ${firstId === secondId}\n`);

  await Node.stop(nodeB);
  console.log('=== Done ===');

  console.log('\n=== Service Exchange Demo ===');
  const provider = await createEmbeddingProviderNode();

  let seeker = Node.create({
    discovery: ['mdns', 'gossip'],
    authentication: {
      enabled: true,
      keyPath: SEEKER_KEY_PATH,
    },
    capabilities: [],
  });
  seeker = await Node.start(seeker);
  console.log('[seeker] started');
  if (seeker.node && provider.node) {
    const addrs = provider.node.getMultiaddrs();
    if (addrs.length > 0) {
      const addr = addrs[0];
      console.log(`[seeker] dialing provider at ${String(addr)}`);
      await seeker.node.dial(addr);
    } else {
      console.warn('[seeker] provider has no listen addresses yet');
    }
  }

  await requestDummyEmbeddings(seeker, Node.getId(provider));

  await printPeers(seeker, 'seeker');
  await printPeers(provider, 'provider');

  await Node.stop(seeker);
  await Node.stop(provider);
  console.log('=== Service Exchange Demo Complete ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


