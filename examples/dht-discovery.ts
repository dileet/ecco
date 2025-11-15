import { Node } from '@ecco/core';

const node1Config = {
  discovery: ['mdns' as const, 'dht' as const, 'gossip' as const], // mDNS for peer discovery, DHT for capability queries, gossip for messaging
  capabilities: [
    {
      type: 'agent',
      name: 'gpt-4',
      version: '1.0.0',
      provider: 'openai',
      features: ['text', 'streaming'],
    },
  ],
};

const node2Config = {
  discovery: ['mdns' as const, 'dht' as const, 'gossip' as const], // mDNS for peer discovery, DHT for capability queries, gossip for messaging
  capabilities: [
    {
      type: 'agent',
      name: 'claude-3',
      version: '1.0.0',
      provider: 'anthropic',
      features: ['text', 'streaming'],
    },
  ],
};

async function main() {
  console.log('Starting DHT discovery test...\n');

  let node1State = Node.create(node1Config);
  node1State = await Node.start(node1State);
  console.log('Node 1 started\n');

  await new Promise(resolve => setTimeout(resolve, 2000));

  let node2State = Node.create(node2Config);
  node2State = await Node.start(node2State);
  console.log('Node 2 started\n');

  await new Promise(resolve => setTimeout(resolve, 5000));

  console.log('Querying for agent capabilities from Node 1...');
  const { matches } = await Node.findPeers(node1State, {
    requiredCapabilities: [
      {
        type: 'agent',
      },
    ],
  });

  console.log(`\nFound ${matches.length} matching peers:`);
  for (const match of matches) {
    console.log(`  - ${match.peer.id} (score: ${match.matchScore.toFixed(2)})`);
    console.log(`    Capabilities: ${match.peer.capabilities.map(c => c.name).join(', ')}`);
  }

  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log('\nStopping nodes...');
  await Node.stop(node1State);
  await Node.stop(node2State);

  console.log('Test complete!');
  process.exit(0);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
