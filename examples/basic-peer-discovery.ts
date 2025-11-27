import {
  init,
  stop,
  findPeers,
  sendMessage,
  delay,
  broadcastCapabilities,
  type EccoNode,
  type Message,
  type CapabilityMatch,
} from '@ecco/core';

async function createNode(
  name: string,
  capabilities: { type: string; name: string; version: string }[]
): Promise<EccoNode> {
  const node = await init(
    {
      discovery: ['mdns', 'gossip'],
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
  console.log('=== Ecco Basic Peer Discovery Example ===\n');

  const nodeA = await createNode('node-a', [
    { type: 'service', name: 'text-generation', version: '1.0.0' },
  ]);

  const nodeB = await createNode('node-b', [
    { type: 'service', name: 'image-recognition', version: '1.0.0' },
  ]);

  const nodeC = await createNode('node-c', [
    { type: 'service', name: 'translation', version: '1.0.0' },
  ]);

  console.log('\nWaiting for peer discovery and mesh formation...\n');
  await delay(3000);

  console.log('Re-broadcasting capabilities after mesh formation...\n');
  await broadcastCapabilities(nodeA.ref);
  await broadcastCapabilities(nodeB.ref);
  await broadcastCapabilities(nodeC.ref);

  await delay(2000);

  console.log('=== Peer Status ===');
  logPeers('node-a', await findPeers(nodeA.ref));
  logPeers('node-b', await findPeers(nodeB.ref));
  logPeers('node-c', await findPeers(nodeC.ref));

  console.log('\n=== Sending Messages ===');

  const peersOfA = await findPeers(nodeA.ref);
  if (peersOfA.length > 0) {
    const targetPeer = peersOfA[0].peer;
    const message: Message = {
      id: crypto.randomUUID(),
      from: nodeA.id,
      to: targetPeer.id,
      type: 'ping',
      payload: 'Hello from node-a!',
      timestamp: Date.now(),
    };

    console.log(`[node-a] Sending message to ${targetPeer.id}`);
    await sendMessage(nodeA.ref, targetPeer.id, message);
  } else {
    console.log('[node-a] No peers to message');
  }

  await delay(1000);

  console.log('\n=== Shutting Down ===');
  await stop(nodeA.ref);
  console.log('[node-a] Stopped');
  await stop(nodeB.ref);
  console.log('[node-b] Stopped');
  await stop(nodeC.ref);
  console.log('[node-c] Stopped');

  console.log('\nExample complete!');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
