import {
  ecco,
  stop,
  sendMessage,
  delay,
  findPeers,
  broadcastCapabilities,
  type EccoNode,
  type Message,
  type CapabilityMatch,
  type CapabilityQuery,
} from '@ecco/core';

async function createBootstrapNode(
  name: string,
  capabilities: { type: string; name: string; version: string }[]
): Promise<EccoNode> {
  const node = await ecco(
    {
      discovery: ['dht', 'gossip'],
      nodeId: name,
      capabilities,
      transport: {
        websocket: {
          enabled: true,
        },
      },
    },
    {
      onMessage: (msg) => {
        console.log(`[${name}] Received message from ${msg.from}: "${msg.payload}"`);
      },
    }
  );

  console.log(`[${name}] Bootstrap node started with ID: ${node.id}`);
  console.log(`[${name}] Listening on: ${node.addrs[0] ?? 'no address'}`);

  return node;
}

async function createNode(
  name: string,
  capabilities: { type: string; name: string; version: string }[],
  bootstrapAddrs: string[]
): Promise<EccoNode> {
  const node = await ecco(
    {
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
    },
    {
      onMessage: (msg) => {
        console.log(`[${name}] Received message from ${msg.from}: "${msg.payload}"`);
      },
    }
  );

  console.log(`[${name}] Started with ID: ${node.id}`);
  console.log(`[${name}] Listening on: ${node.addrs[0] ?? 'no address'}`);

  return node;
}

function logPeers(name: string, matches: CapabilityMatch[]): void {
  if (matches.length === 0) {
    console.log(`[${name}] No peers discovered yet`);
    return;
  }

  console.log(`[${name}] Discovered ${matches.length} peer(s):`);
  for (const match of matches) {
    const caps = match.peer.capabilities.map((c) => c.name).join(', ') || 'none';
    console.log(`  - ${match.peer.id} (capabilities: ${caps})`);
  }
}

async function main(): Promise<void> {
  console.log('=== Ecco DHT Peer Discovery Example ===\n');

  const bootstrapNode = await createBootstrapNode('bootstrap', [
    { type: 'service', name: 'bootstrap-service', version: '1.0.0' },
  ]);

  console.log(`\nBootstrap addresses: ${bootstrapNode.addrs.join(', ')}\n`);

  await delay(2000);

  const nodeA = await createNode(
    'node-a',
    [{ type: 'service', name: 'text-generation', version: '1.0.0' }],
    bootstrapNode.addrs
  );

  const nodeB = await createNode(
    'node-b',
    [{ type: 'service', name: 'image-recognition', version: '1.0.0' }],
    bootstrapNode.addrs
  );

  const nodeC = await createNode(
    'node-c',
    [{ type: 'service', name: 'translation', version: '1.0.0' }],
    bootstrapNode.addrs
  );

  console.log('\nWaiting for DHT peer discovery and mesh formation...\n');
  await delay(5000);

  console.log('Re-broadcasting capabilities after mesh formation...\n');
  await broadcastCapabilities(bootstrapNode.ref);
  await broadcastCapabilities(nodeA.ref);
  await broadcastCapabilities(nodeB.ref);
  await broadcastCapabilities(nodeC.ref);

  await delay(2000);

  console.log('=== Peer Status ===');
  logPeers('bootstrap', await findPeers(bootstrapNode.ref));
  logPeers('node-a', await findPeers(nodeA.ref));
  logPeers('node-b', await findPeers(nodeB.ref));
  logPeers('node-c', await findPeers(nodeC.ref));

  console.log('\n=== DHT Capability Discovery ===');

  const textGenQuery: CapabilityQuery = {
    requiredCapabilities: [{ type: 'service', name: 'text-generation' }],
  };

  console.log('\n[node-b] Searching for text-generation capability via DHT...');
  const textGenMatches = await findPeers(nodeB.ref, textGenQuery);

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
  const translationMatches = await findPeers(nodeA.ref, translationQuery);

  if (translationMatches.length > 0) {
    console.log(`[node-a] Found ${translationMatches.length} peer(s) with translation:`);
    for (const match of translationMatches) {
      console.log(`  - ${match.peer.id} (score: ${match.matchScore})`);
    }
  } else {
    console.log('[node-a] No peers found with translation capability');
  }

  console.log('\n=== Sending Messages ===');

  const peersOfA = await findPeers(nodeA.ref);
  if (peersOfA.length > 0) {
    const targetPeer = peersOfA[0].peer;
    const message: Message = {
      id: crypto.randomUUID(),
      from: nodeA.id,
      to: targetPeer.id,
      type: 'ping',
      payload: 'Hello via DHT network!',
      timestamp: Date.now(),
    };

    console.log(`[node-a] Sending message to ${targetPeer.id}`);
    await sendMessage(nodeA.ref, targetPeer.id, message);
  } else {
    console.log('[node-a] No peers to message');
  }

  await delay(1000);

  console.log('\n=== Shutting Down ===');
  await stop(nodeC.ref);
  console.log('[node-c] Stopped');
  await stop(nodeB.ref);
  console.log('[node-b] Stopped');
  await stop(nodeA.ref);
  console.log('[node-a] Stopped');
  await stop(bootstrapNode.ref);
  console.log('[bootstrap] Stopped');

  console.log('\nExample complete!');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

