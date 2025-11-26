/**
 * Example: Peer-Based Embedding Consensus with Service Exchange
 *
 * This example demonstrates:
 * 1. Embedding as a P2P service capability
 * 2. Reciprocal service exchange (only use peers you've helped)
 * 3. Reputation rewards for embedding providers
 * 4. Semantic consensus using peer embeddings
 */

import { Node, type NodeState, initialOrchestratorState, type MessageEvent } from '@ecco/core';
import { createMultiAgentProvider, isAgentRequest, setupEmbeddingProvider } from '@ecco/ai-sdk';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

async function main() {
  console.log('=== Peer-Based Embedding Consensus Example ===\n');

  const agents = await Promise.all([
    createQuestionAnsweringAgent('agent-1', 7771, 'gpt-4o-mini', 'OpenAI Agent 1'),
    createQuestionAnsweringAgent('agent-2', 7772, 'gpt-4o-mini', 'OpenAI Agent 2'),
    createQuestionAnsweringAgent('agent-3', 7773, 'gpt-4o-mini', 'OpenAI Agent 3'),
  ]);

  const embeddingProvider = await createEmbeddingProvider(
    'embedding-agent',
    7774,
    'Embedding Provider'
  );

  let seekerState = Node.create({
    discovery: ['mdns', 'gossip'],
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

  seekerState = await Node.start(seekerState);

  seekerState = setupEmbeddingProvider({
    nodeState: seekerState,
    embeddingModel: openai.embedding('text-embedding-3-small'),
    modelId: 'text-embedding-3-small',
  });

  console.log('Seeker node started (also provides embeddings)\n');
  console.log('Waiting for peers to discover and connect...\n');

  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log(`Discovered ${Node.getPeers(seekerState).length} peers\n`);

  const orchestratorState = initialOrchestratorState;

  console.log('--- Consensus with Peer Embeddings (Reciprocal Exchange) ---\n');

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
    const peers = Node.getPeers(seekerState);
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
  } catch (error) {
    console.error('Error:', (error as Error).message);
  }

  await Node.stop(seekerState);
  for (const agent of agents) {
    await Node.stop(agent);
  }
  await Node.stop(embeddingProvider);

  console.log('\n=== Example Complete ===');
}

async function createQuestionAnsweringAgent(
  id: string,
  port: number,
  model: string,
  displayName: string
): Promise<NodeState> {
  const agentState = Node.create({
    discovery: ['mdns', 'gossip'],
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

  console.log(`${displayName} started on port ${port}`);
  return agent;
}

async function createEmbeddingProvider(
  id: string,
  port: number,
  displayName: string
): Promise<NodeState> {
  const providerState = Node.create({
    discovery: ['mdns', 'gossip'],
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

  const provider = await Node.start(providerState);

  const providerWithHandler = setupEmbeddingProvider({
    nodeState: provider,
    embeddingModel: openai.embedding('text-embedding-3-small'),
    modelId: 'text-embedding-3-small',
  });

  console.log(`${displayName} started on port ${port} (providing embeddings)`);
  return providerWithHandler;
}

main().catch(console.error);
