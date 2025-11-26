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
  type StateRef,
  type NodeState,
  type Message,
  type PeerInfo,
} from '@ecco/core';

async function createNode(
  name: string,
  port: number,
  capabilities: { type: string; name: string; version: string }[]
): Promise<StateRef<NodeState>> {
  const state = createInitialState({
    discovery: ['mdns', 'gossip'],
    nodeId: name,
    capabilities,
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
  console.log('=== Ecco Basic Peer Discovery Example ===\n');

  const nodeA = await createNode('node-a', 7770, [
    { type: 'service', name: 'text-generation', version: '1.0.0' },
  ]);

  const nodeB = await createNode('node-b', 7771, [
    { type: 'service', name: 'image-recognition', version: '1.0.0' },
  ]);

  const nodeC = await createNode('node-c', 7772, [
    { type: 'service', name: 'translation', version: '1.0.0' },
  ]);

  console.log('\nWaiting for peer discovery...\n');
  await delay(4000);

  console.log('=== Peer Status ===');
  logPeers('node-a', getPeers(nodeA));
  logPeers('node-b', getPeers(nodeB));
  logPeers('node-c', getPeers(nodeC));

  console.log('\n=== Sending Messages ===');

  const peersOfA = getPeers(nodeA);
  if (peersOfA.length > 0) {
    const targetPeer = peersOfA[0];
    const message: Message = {
      id: crypto.randomUUID(),
      from: getId(nodeA),
      to: targetPeer.id,
      type: 'ping',
      payload: 'Hello from node-a!',
      timestamp: Date.now(),
    };

    console.log(`[node-a] Sending message to ${targetPeer.id}`);
    await sendMessage(nodeA, targetPeer.id, message);
  } else {
    console.log('[node-a] No peers to message');
  }

  await delay(1000);

  console.log('\n=== Shutting Down ===');
  await stop(nodeA);
  console.log('[node-a] Stopped');
  await stop(nodeB);
  console.log('[node-b] Stopped');
  await stop(nodeC);
  console.log('[node-c] Stopped');

  console.log('\nExample complete!');
}

main().catch(console.error);
