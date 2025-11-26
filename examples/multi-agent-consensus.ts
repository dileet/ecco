/**
 * Example: Multi-Agent Consensus with Voting and Aggregation
 *
 * This example demonstrates:
 * 1. Multiple agents providing the same capability
 * 2. Different consensus strategies (majority vote, weighted vote, ensemble)
 * 3. Load balancing across agents
 * 4. Output aggregation from multiple agents
 */

import { Node, type NodeState, initialOrchestratorState, type OrchestratorState, type MultiAgentConfig, type MessageEvent } from '@ecco/core';
import { createMultiAgentProvider, isAgentRequest } from '@ecco/ai-sdk';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

async function main() {
  console.log('=== Multi-Agent Consensus Example ===\n');

  // Create multiple agent nodes with the same capability
  const agents = await Promise.all([
    createAgent('agent-1', 7771, 'gpt-4o-mini', 'OpenAI Agent 1'),
    createAgent('agent-2', 7772, 'gpt-4o-mini', 'OpenAI Agent 2'),
    createAgent('agent-3', 7773, 'gpt-4o-mini', 'OpenAI Agent 3'),
  ]);

  // Create seeker node that will query multiple agents
  const seekerState = Node.create({
    discovery: ['mdns', 'gossip'],
    nodeId: 'seeker',
    capabilities: [],
    transport: {
      websocket: { enabled: true, port: 7770 },
    },
  });

  const seeker = await Node.start(seekerState);
  console.log('Seeker node started');

  // Wait for peer discovery
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log(`\nDiscovered ${Node.getPeers(seeker).length} peers\n`);

  const orchestratorState = initialOrchestratorState;

  // ==========================================
  // Example 1: Majority Vote Strategy
  // ==========================================
  console.log('--- Example 1: Majority Vote ---');
  await runWithStrategy(seeker, orchestratorState, {
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

  // ==========================================
  // Example 2: Weighted Vote Strategy
  // ==========================================
  console.log('\n--- Example 2: Weighted Vote (by performance score) ---');
  await runWithStrategy(seeker, orchestratorState, {
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

  // ==========================================
  // Example 3: Ensemble Strategy
  // ==========================================
  console.log('\n--- Example 3: Ensemble (combine all outputs) ---');
  await runWithStrategy(seeker, orchestratorState, {
    selectionStrategy: 'all',
    aggregationStrategy: 'ensemble',
    timeout: 30000,
    allowPartialResults: true,
  });

  // ==========================================
  // Example 4: Consensus Threshold
  // ==========================================
  console.log('\n--- Example 4: Consensus Threshold (60% agreement) with Semantic Similarity ---');
  await runWithStrategy(seeker, orchestratorState, {
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

  // ==========================================
  // Example 5: Round-Robin Load Balancing
  // ==========================================
  console.log('\n--- Example 5: Round-Robin Load Balancing ---');
  for (let i = 0; i < 5; i++) {
    console.log(`\nRequest ${i + 1}:`);
    await runWithStrategy(
      seeker,
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
      true // Show load stats
    );
  }

  // ==========================================
  // Example 6: Weighted Selection with Load Balancing
  // ==========================================
  console.log('\n--- Example 6: Weighted Selection (score + load) ---');
  await runWithStrategy(seeker, orchestratorState, {
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

  // ==========================================
  // Example 7: Best Score Strategy
  // ==========================================
  console.log('\n--- Example 7: Best Score (use highest scoring agent) ---');
  await runWithStrategy(seeker, orchestratorState, {
    selectionStrategy: 'top-n',
    agentCount: 3,
    aggregationStrategy: 'best-score',
    timeout: 30000,
  });

  // ==========================================
  // Example 8: First Response (fastest agent)
  // ==========================================
  console.log('\n--- Example 8: First Response (fastest agent wins) ---');
  await runWithStrategy(seeker, orchestratorState, {
    selectionStrategy: 'all',
    aggregationStrategy: 'first-response',
    timeout: 30000,
    allowPartialResults: true,
  });

  // Clean up
  await Node.stop(seeker);
  for (const agent of agents) {
    await Node.stop(agent);
  }

  console.log('\n=== Example Complete ===');
}

/**
 * Create an agent node with AI capability
 */
async function createAgent(
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

  // Handle agent requests - subscribe to peer-specific topic
  Node.subscribeToTopic(agent, `peer:${Node.getId(agent)}`, async (event) => {
    // Only handle message events with agent-request payloads
    if (event.type !== 'message') return;
    if (!isAgentRequest(event.payload)) return;

    console.log(`${displayName} received request`);

    try {
      const { options } = event.payload.payload;

      // Generate response using OpenAI
      const result = await generateText({
        model: openai(model),
        prompt: options.prompt || 'What is 2+2?',
      });

      // Add agent signature to response
      const responseText = `${result.text} [from ${displayName}]`;

      // Create and send response message
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
      await Node.publish(agent, `response:${event.payload.id}`, errorEvent);
    }
  });

  console.log(`${displayName} started on port ${port}`);
  return agent;
}

/**
 * Run a request with a specific multi-agent strategy
 */
async function runWithStrategy(
  seeker: NodeState,
  orchestratorState: OrchestratorState,
  config: MultiAgentConfig,
  showLoadStats = false
) {
  const provider = createMultiAgentProvider({
    nodeState: seeker,
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
      console.log('\nLoad Statistics:');
      for (const [peerId, stat] of Object.entries(stats)) {
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
