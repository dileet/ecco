/**
 * Simple Multi-Agent Consensus Example
 *
 * This is a minimal example showing how to get started with multi-agent consensus
 */

import { Node, type NodeState, Orchestrator, type MessageEvent } from '@ecco/core';
import { createMultiAgentProvider, isAgentRequest } from '@ecco/ai-sdk';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

async function main() {
  console.log('Starting simple multi-agent consensus example...\n');

  const agent1 = await createSimpleAgent('agent-1', 7771);
  const agent2 = await createSimpleAgent('agent-2', 7772);
  const agent3 = await createSimpleAgent('agent-3', 7773);

  const seekerState = Node.create({
    discovery: ['mdns', 'gossip'],
    capabilities: [],
  });
  const startedSeekerState = await Node.start(seekerState);
  console.log('Seeker started, discovering peers...\n');

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const orchestratorState = Orchestrator.createState();

  const provider = createMultiAgentProvider({
    nodeState: startedSeekerState,
    orchestratorState,
    multiAgentConfig: {
      selectionStrategy: 'all',
      aggregationStrategy: 'majority-vote',
      timeout: 30000,
      allowPartialResults: true,
    },
    enableMetadata: true,
  });

  console.log('Asking: "What is 2 + 2?"\n');

  const model = provider.languageModel('math-agent');
  const result = await model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'What is 2 + 2? Answer with just the number.' }] }],
  });

  console.log('=== Results ===');
  console.log(`Answer: ${result.content[0]?.type === 'text' ? result.content[0].text : ''}`);

  if (result.metadata) {
    console.log(`\nConsensus: ${result.metadata.consensus.achieved}`);
    console.log(`Confidence: ${(result.metadata.consensus.confidence * 100).toFixed(1)}%`);
    console.log(`Agreement: ${result.metadata.consensus.agreement}/${result.metadata.metrics.totalAgents} agents`);
    console.log(`Average latency: ${result.metadata.metrics.averageLatency.toFixed(0)}ms`);
  } else {
    console.log('\nNo metadata available');
  }

  await Node.stop(startedSeekerState);
  await Node.stop(agent1);
  await Node.stop(agent2);
  await Node.stop(agent3);
}

async function createSimpleAgent(id: string, port: number): Promise<NodeState> {
  const agentState = Node.create({
    discovery: ['mdns', 'gossip'],
    nodeId: id,
    capabilities: [
      {
        type: 'agent',
        name: 'math-agent',
        version: '1.0.0',
        metadata: {
          provider: 'openai',
          model: 'gpt-4o-mini',
        },
      },
    ],
    transport: {
      websocket: { enabled: true, port },
    },
  });

  const startedAgentState = await Node.start(agentState);

  Node.subscribeToTopic(startedAgentState, `peer:${Node.getId(startedAgentState)}`, async (event) => {
    if (event.type !== 'message') return;
    if (!isAgentRequest(event.payload)) return;

    try {
      const result = await generateText({
        model: openai('gpt-4o-mini'),
        prompt: event.payload.payload.options.prompt,
      });

      const responseEvent: MessageEvent = {
        type: 'message',
        from: id,
        to: event.from,
        payload: {
          text: result.text,
          finishReason: 'stop',
          usage: result.usage,
        },
        timestamp: Date.now(),
      };

      await Node.publish(startedAgentState, `response:${event.payload.id}`, responseEvent);

      console.log(`${id} responded: ${result.text}`);
    } catch (error) {
      console.error(`${id} error:`, error);
    }
  });

  console.log(`${id} started`);
  return startedAgentState;
}

main().catch(console.error);
