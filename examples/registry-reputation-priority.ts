import { Node, type NodeState, type MessageEvent } from '@ecco/core';
import { isAgentRequest } from '@ecco/ai-sdk';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

async function main() {
  console.log('=== Registry Reputation-Based Priority Example ===\n');
  console.log('This example demonstrates:');
  console.log('1. Multiple provider nodes registered with the registry');
  console.log('2. One provider has higher reputation');
  console.log('3. Seeker prioritizes nodes with higher reputation\n');

  const registryUrl = process.env.REGISTRY_URL ?? 'http://localhost:8081';

  const providers = await Promise.all([
    createProviderAgent('provider-low-rep', 7781, 'gpt-4o-mini', 'Provider (Low Rep)', registryUrl, 5),
    createProviderAgent('provider-high-rep', 7782, 'gpt-4o-mini', 'Provider (High Rep)', registryUrl, 50),
    createProviderAgent('provider-medium-rep', 7783, 'gpt-4o-mini', 'Provider (Medium Rep)', registryUrl, 20),
  ]);

  console.log('\nWaiting for providers to register with registry...\n');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  let seekerState = Node.create({
    discovery: ['mdns', 'gossip', 'registry'],
    registry: registryUrl,
    nodeId: 'seeker',
    capabilities: [],
    transport: {
      websocket: { enabled: true, port: 7780 },
    },
  });

  seekerState = await Node.start(seekerState);

  console.log('Seeker node started');
  console.log(`Connected to registry: ${registryUrl}\n`);

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const isRegistryConnected = await Node.isRegistryConnected(seekerState);
  if (!isRegistryConnected) {
    console.error('Failed to connect to registry');
    await cleanup(seekerState, providers);
    return;
  }

  console.log('--- Finding Providers via Registry (Reputation Prioritized) ---\n');
  console.log('The SDK automatically prioritizes nodes by reputation when connected to registry.\n');

  const { matches } = await Node.findPeers(seekerState, {
    requiredCapabilities: [{ type: 'agent', name: 'question-answering' }],
  });

  if (matches.length === 0) {
    console.log('No providers found');
    await cleanup(seekerState, providers);
    return;
  }

  console.log('Found providers (sorted by reputation):');
  for (const match of matches) {
    const rep = match.peer.reputation ?? 0;
    console.log(`  ${match.peer.id}: reputation = ${rep}, matchScore = ${match.matchScore.toFixed(2)}`);
  }

  const highestRepMatch = matches[0];
  console.log(`\nHighest reputation provider: ${highestRepMatch.peer.id} (reputation: ${highestRepMatch.peer.reputation ?? 0})\n`);

  console.log('--- Broadcasting Request (SDK Auto-Prioritizes) ---\n');
  console.log('The SDK will automatically select the highest reputation node.\n');

  const requestId = `request-${Date.now()}`;
  const request = {
    type: 'agent-request',
    id: requestId,
    payload: {
      model: 'gpt-4o-mini',
      options: {
        prompt: 'What is the capital of France?',
      },
    },
  };

  const peerTopic = `peer:${highestRepMatch.peer.id}`;
  seekerState = Node.subscribeToTopic(seekerState, peerTopic, () => {});

  await new Promise((resolve) => setTimeout(resolve, 500));

  const responsePromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Request timeout'));
    }, 15000);

    const stateWithSub = Node.subscribeToTopic(
      seekerState,
      `response:${requestId}`,
      (event) => {
        if (event.type === 'message') {
          const payload = event.payload as { text?: string; error?: string };
          clearTimeout(timeout);
          if (payload.error) {
            reject(new Error(payload.error));
          } else {
            resolve(payload.text || 'No response text');
          }
        }
      }
    );

    seekerState = stateWithSub;

    const messageEvent: MessageEvent = {
      type: 'message',
      from: Node.getId(seekerState),
      to: highestRepMatch.peer.id,
      payload: request,
      timestamp: Date.now(),
    };
    Node.publish(seekerState, peerTopic, messageEvent);
  });

  try {
    const result = await responsePromise;
    console.log(`Response received: ${result}`);
    console.log(`\n✓ Successfully used ${highestRepMatch.peer.id} (highest reputation)`);
    console.log('Note: The SDK automatically prioritized this node based on reputation.\n');
  } catch (error) {
    console.error('Request failed:', (error as Error).message);
  }

  console.log('--- Testing All Providers ---\n');
  console.log('Broadcasting to all providers to show they all respond...\n');

  for (const match of matches) {
    const broadcastPeerTopic = `peer:${match.peer.id}`;
    seekerState = Node.subscribeToTopic(seekerState, broadcastPeerTopic, () => {});
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  for (const match of matches) {
    const broadcastRequestId = `broadcast-${Date.now()}-${match.peer.id}`;
    const broadcastRequest = {
      type: 'agent-request',
      id: broadcastRequestId,
      payload: {
        model: 'gpt-4o-mini',
        options: {
          prompt: 'Say hello',
        },
      },
    };

    const broadcastPeerTopic = `peer:${match.peer.id}`;

    const broadcastPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Broadcast timeout'));
      }, 10000);

      const stateWithSub = Node.subscribeToTopic(
        seekerState,
        `response:${broadcastRequestId}`,
        (event) => {
          if (event.type === 'message') {
            const payload = event.payload as { text?: string; error?: string };
            clearTimeout(timeout);
            if (payload.error) {
              reject(new Error(payload.error));
            } else {
              resolve(payload.text || 'No response text');
            }
          }
        }
      );

      seekerState = stateWithSub;

      const broadcastMessageEvent: MessageEvent = {
        type: 'message',
        from: Node.getId(seekerState),
        to: match.peer.id,
        payload: broadcastRequest,
        timestamp: Date.now(),
      };
      Node.publish(seekerState, broadcastPeerTopic, broadcastMessageEvent);
    });

    try {
      const result = await broadcastPromise;
      const rep = match.peer.reputation ?? 0;
      console.log(`  ${match.peer.id} (rep: ${rep}): ${result.substring(0, 50)}...`);
    } catch (error) {
      const rep = match.peer.reputation ?? 0;
      console.log(`  ${match.peer.id} (rep: ${rep}): No response`);
    }
  }

  await cleanup(seekerState, providers);
  console.log('\n=== Example Complete ===');
}

async function createProviderAgent(
  id: string,
  port: number,
  model: string,
  displayName: string,
  registryUrl: string,
  initialReputation: number
): Promise<NodeState> {
  const agentState = Node.create({
    discovery: ['mdns', 'gossip', 'registry'],
    registry: registryUrl,
    nodeId: id,
    capabilities: [
      {
        type: 'agent',
        name: 'question-answering',
        version: '1.0.0',
        metadata: {
          provider: 'openai',
          model: model,
          features: ['text'],
        },
      },
    ],
    transport: {
      websocket: { enabled: true, port },
    },
  });

  const agent = await Node.start(agentState);

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const isRegistryConnected = await Node.isRegistryConnected(agent);
  if (isRegistryConnected) {
    try {
      await Node.setRegistryReputation(agent, id, initialReputation);
      console.log(`${displayName} registered with reputation: ${initialReputation}`);
    } catch (error) {
      console.log(`${displayName} registered (could not set initial reputation)`);
    }
  }

  Node.subscribeToTopic(agent, `peer:${Node.getId(agent)}`, async (event) => {
    if (event.type !== 'message') return;
    if (!isAgentRequest(event.payload)) return;

    console.log(`[${displayName}] Received request`);

    try {
      const { options } = event.payload.payload;

      const result = await generateText({
        model: openai(model),
        prompt: options.prompt || 'What is 2+2?',
      });

      const responseText = `${result.text} [from ${displayName}]`;

      const responseEvent: MessageEvent = {
        type: 'message',
        from: id,
        to: event.from,
        payload: {
          text: responseText,
          finishReason: 'stop',
          usage: result.usage,
          warnings: [],
        },
        timestamp: Date.now(),
      };

      await Node.publish(agent, `response:${event.payload.id}`, responseEvent);

      console.log(`[${displayName}] Sent response`);
    } catch (error) {
      console.error(`[${displayName}] Error:`, error);
      const errorEvent: MessageEvent = {
        type: 'message',
        from: id,
        to: event.from,
        payload: {
          error: (error as Error).message,
        },
        timestamp: Date.now(),
      };
      await Node.publish(agent, `response:${event.payload.id}`, errorEvent);
    }
  });

  return agent;
}

async function cleanup(seekerState: NodeState, providers: NodeState[]): Promise<void> {
  await Node.stop(seekerState);
  for (const provider of providers) {
    await Node.stop(provider);
  }
}

main().catch(console.error);

