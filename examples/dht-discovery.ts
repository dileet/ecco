import { createInitialState, start, stop, findPeers, type StateRef, type NodeState } from '@ecco/core';

const node1Config = {
  discovery: ['mdns' as const, 'dht' as const, 'gossip' as const],
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
  discovery: ['mdns' as const, 'dht' as const, 'gossip' as const],
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

  const node1State = createInitialState(node1Config);
  const node1Ref = await start(node1State);
  console.log('Node 1 started\n');

  await new Promise(resolve => setTimeout(resolve, 2000));

  const node2State = createInitialState(node2Config);
  const node2Ref = await start(node2State);
  console.log('Node 2 started\n');

  await new Promise(resolve => setTimeout(resolve, 5000));

  console.log('Querying for agent capabilities from Node 1...');
  const matches = await findPeers(node1Ref, {
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
  await stop(node1Ref);
  await stop(node2Ref);

  console.log('Test complete!');
  process.exit(0);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
