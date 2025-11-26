import { createInitialState, start, stop, getPeers, isRegistryConnected, subscribeToTopic, getId, publish, type NodeState, initialOrchestratorState, type MessageEvent } from '@ecco/core';
import { createMultiAgentProvider, isAgentRequest, setupEmbeddingProvider } from '@ecco/ai-sdk';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

async function main() {
  console.log('=== Registry-Based Embedding Consensus Example ===\n');
  console.log('This example demonstrates:');
  console.log('1. Nodes connected to a registry');
  console.log('2. Peer-based embedding consensus');
  console.log('3. Automatic reputation increase for embedding providers\n');

  const registryUrl = process.env.REGISTRY_URL ?? 'http://localhost:8081';

  const agents = await Promise.all([
    createQuestionAnsweringAgent('agent-1', 7771, 'gpt-4o-mini', 'OpenAI Agent 1', registryUrl),
    createQuestionAnsweringAgent('agent-2', 7772, 'gpt-4o-mini', 'OpenAI Agent 2', registryUrl),
    createQuestionAnsweringAgent('agent-3', 7773, 'gpt-4o-mini', 'OpenAI Agent 3', registryUrl),
  ]);

  const embeddingProvider = await createEmbeddingProvider(
    'embedding-agent',
    7774,
    'Embedding Provider',
    registryUrl
  );

  let seekerState = createInitialState({
    discovery: ['mdns', 'gossip', 'registry'],
    registry: registryUrl,
    nodeId: 'seeker',
    capabilities: [
      {
        type: 'embedding',
        name: 'text-embedding',
        version: '1.0.0',
        metadata: {
          provider: 'openai',
          model: 'text-embedding-3-small',
        },
      },
    ],
    transport: {
      websocket: { enabled: true, port: 7770 },
    },
  });

  seekerState = await start(seekerState);

  seekerState = setupEmbeddingProvider({
    nodeState: seekerState,
    embeddingModel: openai.embedding('text-embedding-3-small'),
    modelId: 'text-embedding-3-small',
  });

  console.log('Seeker node started (also provides embeddings)');
  console.log(`Connected to registry: ${registryUrl}\n`);
  console.log('Waiting for peers to discover and connect...\n');

  await new Promise((resolve) => setTimeout(resolve, 5000));

  const peers = getPeers(seekerState);
  console.log(`Discovered ${peers.length} peers\n`);

  const isRegistryConnected = await isRegistryConnected(seekerState);
  if (isRegistryConnected) {
    console.log('Registry connection: ✓ Connected\n');
  } else {
    console.log('Registry connection: ✗ Not connected\n');
  }

  const orchestratorState = initialOrchestratorState;

  console.log('--- Consensus with Peer Embeddings (Registry-Based) ---\n');

  const provider = createMultiAgentProvider({
    nodeState: seekerState,
    orchestratorState,
    multiAgentConfig: {
      selectionStrategy: 'all',
      aggregationStrategy: 'consensus-threshold',
      consensusThreshold: 0.6,
      minAgents: 2,
      timeout: 30000,
      allowPartialResults: true,
      semanticSimilarity: {
        enabled: true,
        method: 'peer-embedding',
        threshold: 0.75,
        requireExchange: false,
      },
    },
    enableMetadata: true,
  });

  try {
    const model = provider.languageModel('question-answering');
    const result = await model.doGenerate({
      prompt: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'What is the capital of France?' }],
        },
      ],
    });

    const resultText =
      result.content[0]?.type === 'text' ? result.content[0].text : '';
    console.log(`\nResult: ${resultText}`);

    if (result.metadata) {
      console.log('\nConsensus Info:');
      console.log(`  Strategy: ${result.metadata.strategy}`);
      console.log(`  Achieved: ${result.metadata.consensus.achieved}`);
      console.log(
        `  Confidence: ${(result.metadata.consensus.confidence * 100).toFixed(1)}%`
      );
      console.log(`  Agreement: ${result.metadata.consensus.agreement} agents`);
      console.log('\nMetrics:');
      console.log(`  Total Agents: ${result.metadata.metrics.totalAgents}`);
      console.log(`  Successful: ${result.metadata.metrics.successfulAgents}`);
      console.log(`  Failed: ${result.metadata.metrics.failedAgents}`);
      console.log(
        `  Avg Latency: ${result.metadata.metrics.averageLatency.toFixed(0)}ms`
      );
      console.log(`  Total Time: ${result.metadata.metrics.totalTime}ms`);
    }

    console.log('\n--- Peer Service Statistics ---');
    for (const peer of peers) {
      console.log(`\n${peer.id}:`);
      console.log(`  Services Provided: ${peer.servicesProvided || 0}`);
      console.log(`  Services Consumed: ${peer.servicesConsumed || 0}`);
      console.log(
        `  Balance: ${(peer.servicesProvided || 0) - (peer.servicesConsumed || 0)}`
      );
      console.log(
        `  Capabilities: ${peer.capabilities.map((c) => c.type).join(', ')}`
      );
    }

    const isRegistryConnected = await isRegistryConnected(seekerState);
    if (isRegistryConnected) {
      console.log('\n--- Registry Reputation Note ---');
      const embeddingPeer = peers.find(p => 
        p.capabilities.some(c => c.type === 'embedding')
      );
      
      if (embeddingPeer) {
        console.log(`\n${embeddingPeer.id} reputation: ${embeddingPeer.reputation ?? 'unknown'}`);
        console.log('(Reputation automatically increased after embedding completion)');
        console.log('(SDK automatically prioritizes nodes by reputation when connected to registry)');
      }
    }
  } catch (error) {
    console.error('Error:', (error as Error).message);
  }

  await stop(seekerState);
  for (const agent of agents) {
    await stop(agent);
  }
  await stop(embeddingProvider);

  console.log('\n=== Example Complete ===');
}

async function createQuestionAnsweringAgent(
  id: string,
  port: number,
  model: string,
  displayName: string,
  registryUrl: string
): Promise<NodeState> {
  const agentState = createInitialState({
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

  const agent = await start(agentState);

  subscribeToTopic(agent, `peer:${getId(agent)}`, async (event) => {
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

      await publish(agent, `response:${event.payload.id}`, responseEvent);

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
      await publish(agent, `response:${event.payload.id}`, errorEvent);
    }
  });

  console.log(`${displayName} started on port ${port} (connected to registry)`);
  return agent;
}

async function createEmbeddingProvider(
  id: string,
  port: number,
  displayName: string,
  registryUrl: string
): Promise<NodeState> {
  const providerState = createInitialState({
    discovery: ['mdns', 'gossip', 'registry'],
    registry: registryUrl,
    nodeId: id,
    capabilities: [
      {
        type: 'embedding',
        name: 'text-embedding',
        version: '1.0.0',
        metadata: {
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
        },
      },
    ],
    transport: {
      websocket: { enabled: true, port },
    },
  });

  const provider = await start(providerState);

  const providerWithHandler = setupEmbeddingProvider({
    nodeState: provider,
    embeddingModel: openai.embedding('text-embedding-3-small'),
    modelId: 'text-embedding-3-small',
  });

  console.log(`${displayName} started on port ${port} (providing embeddings, connected to registry)`);
  return providerWithHandler;
}

main().catch(console.error);

