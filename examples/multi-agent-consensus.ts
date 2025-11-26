import { createInitialState, start, stop, getPeers, subscribeToTopic, getId, publish, type StateRef, type NodeState, initialOrchestratorState, type OrchestratorState, type MultiAgentConfig, type MessageEvent } from '@ecco/core';
import { createMultiAgentProvider, isAgentRequest } from '@ecco/ai-sdk';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

async function main() {
  console.log('=== Multi-Agent Consensus Example ===\n');

  const agents = await Promise.all([
    createAgent('agent-1', 7771, 'gpt-4o-mini', 'OpenAI Agent 1'),
    createAgent('agent-2', 7772, 'gpt-4o-mini', 'OpenAI Agent 2'),
    createAgent('agent-3', 7773, 'gpt-4o-mini', 'OpenAI Agent 3'),
  ]);

  const seekerState = createInitialState({
    discovery: ['mdns', 'gossip'],
    nodeId: 'seeker',
    capabilities: [],
    transport: {
      websocket: { enabled: true, port: 7770 },
    },
  });

  const seekerRef = await start(seekerState);
  console.log('Seeker node started');

  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log(`\nDiscovered ${getPeers(seekerRef).length} peers\n`);

  const orchestratorState = initialOrchestratorState;

  console.log('--- Example 1: Majority Vote ---');
  await runWithStrategy(seekerRef, orchestratorState, {
    selectionStrategy: 'all',
    aggregationStrategy: 'majority-vote',
    timeout: 30000,
    allowPartialResults: true,
    semanticSimilarity: {
      enabled: true,
      method: 'text-overlap',
      threshold: 0.75,
    },
  });

  console.log('\n--- Example 2: Weighted Vote (by performance score) ---');
  await runWithStrategy(seekerRef, orchestratorState, {
    selectionStrategy: 'all',
    aggregationStrategy: 'weighted-vote',
    timeout: 30000,
    allowPartialResults: true,
    semanticSimilarity: {
      enabled: true,
      method: 'text-overlap',
      threshold: 0.75,
    },
  });

  console.log('\n--- Example 3: Ensemble (combine all outputs) ---');
  await runWithStrategy(seekerRef, orchestratorState, {
    selectionStrategy: 'all',
    aggregationStrategy: 'ensemble',
    timeout: 30000,
    allowPartialResults: true,
  });

  console.log('\n--- Example 4: Consensus Threshold (60% agreement) with Semantic Similarity ---');
  await runWithStrategy(seekerRef, orchestratorState, {
    selectionStrategy: 'all',
    aggregationStrategy: 'consensus-threshold',
    consensusThreshold: 0.6,
    minAgents: 2,
    timeout: 30000,
    allowPartialResults: true,
    semanticSimilarity: {
      enabled: true,
      method: 'text-overlap',
      threshold: 0.75,
    },
  });

  console.log('\n--- Example 5: Round-Robin Load Balancing ---');
  for (let i = 0; i < 5; i++) {
    console.log(`\nRequest ${i + 1}:`);
    await runWithStrategy(
      seekerRef,
      orchestratorState,
      {
        selectionStrategy: 'round-robin',
        agentCount: 1,
        aggregationStrategy: 'best-score',
        timeout: 30000,
        loadBalancing: {
          enabled: true,
          trackRequestCounts: true,
        },
      },
      true
    );
  }

  console.log('\n--- Example 6: Weighted Selection (score + load) ---');
  await runWithStrategy(seekerRef, orchestratorState, {
    selectionStrategy: 'weighted',
    agentCount: 2,
    aggregationStrategy: 'majority-vote',
    timeout: 30000,
    loadBalancing: {
      enabled: true,
      preferLessLoaded: true,
      loadWeight: 0.4,
    },
    semanticSimilarity: {
      enabled: true,
      method: 'text-overlap',
      threshold: 0.75,
    },
  });

  console.log('\n--- Example 7: Best Score (use highest scoring agent) ---');
  await runWithStrategy(seekerRef, orchestratorState, {
    selectionStrategy: 'top-n',
    agentCount: 3,
    aggregationStrategy: 'best-score',
    timeout: 30000,
  });

  console.log('\n--- Example 8: First Response (fastest agent wins) ---');
  await runWithStrategy(seekerRef, orchestratorState, {
    selectionStrategy: 'all',
    aggregationStrategy: 'first-response',
    timeout: 30000,
    allowPartialResults: true,
  });

  await stop(seekerRef);
  for (const agent of agents) {
    await stop(agent);
  }

  console.log('\n=== Example Complete ===');
}

async function createAgent(
  id: string,
  port: number,
  model: string,
  displayName: string
): Promise<StateRef<NodeState>> {
  const agentState = createInitialState({
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

  const agentRef = await start(agentState);

  subscribeToTopic(agentRef, `peer:${getId(agentRef)}`, async (event) => {
    if (event.type !== 'message') return;
    if (!isAgentRequest(event.payload)) return;

    console.log(`${displayName} received request`);

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

      await publish(agentRef, `response:${event.payload.id}`, responseEvent);

      console.log(`${displayName} sent response: "${responseText}"`);
    } catch (error) {
      console.error(`${displayName} error:`, error);
      const errorEvent: MessageEvent = {
        type: 'message',
        from: id,
        to: event.from,
        payload: {
          error: (error as Error).message,
        },
        timestamp: Date.now(),
      };
      await publish(agentRef, `response:${event.payload.id}`, errorEvent);
    }
  });

  console.log(`${displayName} started on port ${port}`);
  return agentRef;
}

async function runWithStrategy(
  seekerRef: StateRef<NodeState>,
  orchestratorState: OrchestratorState,
  config: MultiAgentConfig,
  showLoadStats = false
) {
  const provider = createMultiAgentProvider({
    nodeRef: seekerRef,
    orchestratorState,
    multiAgentConfig: config,
    enableMetadata: true,
  });

  try {
    const model = provider.languageModel('question-answering');
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'What is the capital of France?' }] }],
    });

    const resultText = result.content[0]?.type === 'text' ? result.content[0].text : '';
    console.log(`Result: ${resultText}`);

    if (result.metadata) {
      console.log('\nConsensus Info:');
      console.log(`  Strategy: ${result.metadata.strategy}`);
      console.log(`  Achieved: ${result.metadata.consensus.achieved}`);
      console.log(`  Confidence: ${(result.metadata.consensus.confidence * 100).toFixed(1)}%`);
      console.log(`  Agreement: ${result.metadata.consensus.agreement} agents`);
      console.log('\nMetrics:');
      console.log(`  Total Agents: ${result.metadata.metrics.totalAgents}`);
      console.log(`  Successful: ${result.metadata.metrics.successfulAgents}`);
      console.log(`  Failed: ${result.metadata.metrics.failedAgents}`);
      console.log(`  Avg Latency: ${result.metadata.metrics.averageLatency.toFixed(0)}ms`);
      console.log(`  Total Time: ${result.metadata.metrics.totalTime}ms`);
    }

    if (showLoadStats) {
      const stats = model.getLoadStatistics();
      for (const [peerId, stat] of Object.entries(stats)) {
        console.log('\nLoad Statistics:');
        console.log(`  ${peerId}:`);
        console.log(`    Active: ${stat.activeRequests}`);
        console.log(`    Total: ${stat.totalRequests}`);
        console.log(`    Success Rate: ${(stat.successRate * 100).toFixed(1)}%`);
        console.log(`    Avg Latency: ${stat.averageLatency.toFixed(0)}ms`);
      }
    }
  } catch (error) {
    console.error('Error:', (error as Error).message);
  }
}

main().catch(console.error);
