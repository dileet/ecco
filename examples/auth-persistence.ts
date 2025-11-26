import { createInitialState, start, stop, getPeers, getId, subscribeToTopic, publish, EmbeddingService, isEmbeddingRequest, getState, setState, type StateRef, type NodeState, type MessageEvent } from '@ecco/core';
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

function printPeers(ref: StateRef<NodeState>, label: string) {
  const peers = getPeers(ref);
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

async function createEmbeddingProviderNode(): Promise<StateRef<NodeState>> {
  const providerState = createInitialState({
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
  const providerRef = await start(providerState);

  subscribeToTopic(providerRef, `peer:${getId(providerRef)}`, async (event) => {
    if (event.type !== 'message') return;
    if (!isEmbeddingRequest(event.payload)) return;
    try {
      const { requestId, texts } = event.payload;

      const state = getState(providerRef);
      if (!state.peers[event.from]) {
        setState(providerRef, {
          ...state,
          peers: {
            ...state.peers,
            [event.from]: {
              id: event.from,
              addresses: [],
              capabilities: [],
              lastSeen: Date.now(),
            },
          },
        });
      }

      const embeddings = texts.map(createDummyEmbedding);
      const response = {
        type: 'embedding-response' as const,
        requestId,
        embeddings,
        model: 'dummy',
        dimensions: 4,
      };
      const responseEvent: MessageEvent = {
        type: 'message',
        from: getId(providerRef),
        to: event.from,
        payload: response,
        timestamp: Date.now(),
      };
      await publish(providerRef, `embedding-response:${requestId}`, responseEvent);
      await publish(providerRef, `peer:${event.from}`, responseEvent);

      EmbeddingService.updatePeerServiceProvided(providerRef, event.from);
      console.log(`[provider] served ${texts.length} embeddings to ${event.from}`);
    } catch (err) {
      console.error('[provider] error handling embedding request:', err);
    }
  });

  console.log('[provider] started');
  return providerRef;
}

async function requestDummyEmbeddings(seekerRef: StateRef<NodeState>, preferredPeerId: string): Promise<void> {
  try {
    const embeddings = await EmbeddingService.requestEmbeddings(seekerRef, ['hello world', 'identity persistence'], { model: 'dummy', preferredPeers: [preferredPeerId] });
    console.log(`[seeker] received ${embeddings.length} embeddings`);
  } catch (err) {
    console.log('[seeker] embedding request failed:', (err as Error).message);
  }
}

async function main() {
  console.log('=== Auth Persistence Test ===\n');
  console.log(`Key file path: ${KEY_PATH}\n`);

  const nodeAState = createInitialState({
    discovery: ['mdns', 'gossip'],
    authentication: {
      enabled: true,
      keyPath: KEY_PATH,
    },
  });
  const nodeARef = await start(nodeAState);
  const firstId = getId(nodeARef);
  console.log(`First start Node ID: ${firstId}`);
  console.log(`Key file exists after first start: ${await fileExists(KEY_PATH)}\n`);
  await stop(nodeARef);

  const nodeBState = createInitialState({
    discovery: ['mdns', 'gossip'],
    authentication: {
      enabled: true,
      keyPath: KEY_PATH,
    },
  });
  const nodeBRef = await start(nodeBState);
  const secondId = getId(nodeBRef);
  console.log(`Second start Node ID: ${secondId}`);
  console.log(`IDs match: ${firstId === secondId}\n`);

  await stop(nodeBRef);
  console.log('=== Done ===');

  console.log('\n=== Service Exchange Demo ===');
  const providerRef = await createEmbeddingProviderNode();

  const seekerState = createInitialState({
    discovery: ['mdns', 'gossip'],
    authentication: {
      enabled: true,
      keyPath: SEEKER_KEY_PATH,
    },
    capabilities: [],
  });
  const seekerRef = await start(seekerState);
  console.log('[seeker] started');

  const seekerNodeState = getState(seekerRef);
  const providerNodeState = getState(providerRef);
  if (seekerNodeState.node && providerNodeState.node) {
    const addrs = providerNodeState.node.getMultiaddrs();
    if (addrs.length > 0) {
      const addr = addrs[0];
      console.log(`[seeker] dialing provider at ${String(addr)}`);
      await seekerNodeState.node.dial(addr);
    } else {
      console.warn('[seeker] provider has no listen addresses yet');
    }
  }

  await requestDummyEmbeddings(seekerRef, getId(providerRef));

  printPeers(seekerRef, 'seeker');
  printPeers(providerRef, 'provider');

  await stop(seekerRef);
  await stop(providerRef);
  console.log('=== Service Exchange Demo Complete ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
