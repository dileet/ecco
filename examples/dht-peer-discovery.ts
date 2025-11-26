import {
  createInitialState,
  start,
  stop,
  subscribeToTopic,
  getId,
  getPeers,
  sendMessage,
  getMultiaddrs,
  delay,
  findPeers,
  broadcastCapabilities,
  type StateRef,
  type NodeState,
  type Message,
  type PeerInfo,
  type CapabilityQuery,
} from '@ecco/core';

async function createBootstrapNode(
  name: string,
  capabilities: { type: string; name: string; version: string }[]
): Promise<StateRef<NodeState>> {
  const state = createInitialState({
    discovery: ['dht', 'gossip'],
    nodeId: name,
    capabilities,
    transport: {
      websocket: {
        enabled: true,
      },
    },
  });

  const ref = await start(state);
  const id = getId(ref);
  const addrs = getMultiaddrs(ref);

  console.log(`[${name}] Bootstrap node started with ID: ${id}`);
  console.log(`[${name}] Listening on: ${addrs[0] ?? 'no address'}`);

  subscribeToTopic(ref, `peer:${id}`, (event) => {
    if (event.type !== 'message') return;
    const msg = event.payload as Message;
    console.log(`[${name}] Received message from ${msg.from}: "${msg.payload}"`);
  });

  return ref;
}

async function createNode(
  name: string,
  capabilities: { type: string; name: string; version: string }[],
  bootstrapAddrs: string[]
): Promise<StateRef<NodeState>> {
  const state = createInitialState({
    discovery: ['dht', 'gossip'],
    nodeId: name,
    capabilities,
    transport: {
      websocket: {
        enabled: true,
      },
    },
    bootstrap: {
      enabled: true,
      peers: bootstrapAddrs,
      timeout: 10000,
      minPeers: 1,
    },
  });

  const ref = await start(state);
  const id = getId(ref);
  const addrs = getMultiaddrs(ref);

  console.log(`[${name}] Started with ID: ${id}`);
  console.log(`[${name}] Listening on: ${addrs[0] ?? 'no address'}`);

  subscribeToTopic(ref, `peer:${id}`, (event) => {
    if (event.type !== 'message') return;
    const msg = event.payload as Message;
    console.log(`[${name}] Received message from ${msg.from}: "${msg.payload}"`);
  });

  return ref;
}

function logPeers(name: string, peers: PeerInfo[]): void {
  if (peers.length === 0) {
    console.log(`[${name}] No peers discovered yet`);
    return;
  }

  console.log(`[${name}] Discovered ${peers.length} peer(s):`);
  for (const peer of peers) {
    const caps = peer.capabilities.map((c) => c.name).join(', ') || 'none';
    console.log(`  - ${peer.id} (capabilities: ${caps})`);
  }
}

async function main(): Promise<void> {
  console.log('=== Ecco DHT Peer Discovery Example ===\n');

  const bootstrapNode = await createBootstrapNode('bootstrap', [
    { type: 'service', name: 'bootstrap-service', version: '1.0.0' },
  ]);

  const bootstrapAddrs = getMultiaddrs(bootstrapNode);
  console.log(`\nBootstrap addresses: ${bootstrapAddrs.join(', ')}\n`);

  await delay(2000);

  const nodeA = await createNode(
    'node-a',
    [{ type: 'service', name: 'text-generation', version: '1.0.0' }],
    bootstrapAddrs
  );

  const nodeB = await createNode(
    'node-b',
    [{ type: 'service', name: 'image-recognition', version: '1.0.0' }],
    bootstrapAddrs
  );

  const nodeC = await createNode(
    'node-c',
    [{ type: 'service', name: 'translation', version: '1.0.0' }],
    bootstrapAddrs
  );

  console.log('\nWaiting for DHT peer discovery and mesh formation...\n');
  await delay(5000);

  console.log('Re-broadcasting capabilities after mesh formation...\n');
  await broadcastCapabilities(bootstrapNode);
  await broadcastCapabilities(nodeA);
  await broadcastCapabilities(nodeB);
  await broadcastCapabilities(nodeC);

  await delay(2000);

  console.log('=== Peer Status ===');
  logPeers('bootstrap', getPeers(bootstrapNode));
  logPeers('node-a', getPeers(nodeA));
  logPeers('node-b', getPeers(nodeB));
  logPeers('node-c', getPeers(nodeC));

  console.log('\n=== DHT Capability Discovery ===');

  const textGenQuery: CapabilityQuery = {
    requiredCapabilities: [{ type: 'service', name: 'text-generation' }],
  };

  console.log('\n[node-b] Searching for text-generation capability via DHT...');
  const textGenMatches = await findPeers(nodeB, textGenQuery);

  if (textGenMatches.length > 0) {
    console.log(`[node-b] Found ${textGenMatches.length} peer(s) with text-generation:`);
    for (const match of textGenMatches) {
      console.log(`  - ${match.peer.id} (score: ${match.matchScore})`);
    }
  } else {
    console.log('[node-b] No peers found with text-generation capability');
  }

  const translationQuery: CapabilityQuery = {
    requiredCapabilities: [{ type: 'service', name: 'translation' }],
  };

  console.log('\n[node-a] Searching for translation capability via DHT...');
  const translationMatches = await findPeers(nodeA, translationQuery);

  if (translationMatches.length > 0) {
    console.log(`[node-a] Found ${translationMatches.length} peer(s) with translation:`);
    for (const match of translationMatches) {
      console.log(`  - ${match.peer.id} (score: ${match.matchScore})`);
    }
  } else {
    console.log('[node-a] No peers found with translation capability');
  }

  console.log('\n=== Sending Messages ===');

  const peersOfA = getPeers(nodeA);
  if (peersOfA.length > 0) {
    const targetPeer = peersOfA[0];
    const message: Message = {
      id: crypto.randomUUID(),
      from: getId(nodeA),
      to: targetPeer.id,
      type: 'ping',
      payload: 'Hello via DHT network!',
      timestamp: Date.now(),
    };

    console.log(`[node-a] Sending message to ${targetPeer.id}`);
    await sendMessage(nodeA, targetPeer.id, message);
  } else {
    console.log('[node-a] No peers to message');
  }

  await delay(1000);

  console.log('\n=== Shutting Down ===');
  await stop(nodeC);
  console.log('[node-c] Stopped');
  await stop(nodeB);
  console.log('[node-b] Stopped');
  await stop(nodeA);
  console.log('[node-a] Stopped');
  await stop(bootstrapNode);
  console.log('[bootstrap] Stopped');

  console.log('\nExample complete!');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

