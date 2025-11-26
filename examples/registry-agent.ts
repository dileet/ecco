import { createInitialState, start, stop, getId, type StateRef, type NodeState } from '@ecco/core';
import { promises as fs } from 'fs';

const KEY_PATH = '.keys/registry-agent.json';

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const registryUrl = process.env.REGISTRY_URL ?? 'ws://localhost:8081/ws';
  
  console.log('=== Registry Agent with Auth Persistence ===\n');
  console.log(`Key file path: ${KEY_PATH}`);
  console.log(`Key file exists: ${await fileExists(KEY_PATH)}\n`);
  
  const node = createInitialState({
    discovery: ['mdns', 'gossip', 'registry'],
    registry: registryUrl,
    authentication: {
      enabled: true,
      keyPath: KEY_PATH,
    },
    capabilities: [
      {
        type: 'agent',
        name: 'demo-agent',
        version: '1.0.0',
      },
    ]
  });
  
  const nodeRef = await start(node);
  const nodeId = getId(nodeRef);
  
  console.log('Agent started with id:', nodeId);
  console.log('Connected to registry via WebSocket:', registryUrl);
  console.log(`Key file exists after start: ${await fileExists(KEY_PATH)}`);
  console.log('\nNote: Restart this agent to see the same nodeId and registry reactivation!');
  
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await stop(nodeRef);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
