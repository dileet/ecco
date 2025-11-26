import { createInitialState, start, stop, subscribeToTopic, getId, publish, type StateRef, type NodeState, initialOrchestratorState, type MessageEvent } from '@ecco/core';
import { createMultiAgentProvider, isAgentRequest } from '@ecco/ai-sdk';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

async function main() {
  console.log('Starting simple multi-agent consensus example...\n');

  const agent1 = await createSimpleAgent('agent-1', 7771);
  const agent2 = await createSimpleAgent('agent-2', 7772);
  const agent3 = await createSimpleAgent('agent-3', 7773);

  const seekerState = createInitialState({
    discovery: ['mdns', 'gossip'],
    capabilities: [],
  });
  const seekerRef = await start(seekerState);
  console.log('Seeker started, discovering peers...\n');

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const orchestratorState = initialOrchestratorState;

  const provider = createMultiAgentProvider({
    nodeRef: seekerRef,
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

  await stop(seekerRef);
  await stop(agent1);
  await stop(agent2);
  await stop(agent3);
}

async function createSimpleAgent(id: string, port: number): Promise<StateRef<NodeState>> {
  const agentState = createInitialState({
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

  const agentRef = await start(agentState);

  subscribeToTopic(agentRef, `peer:${getId(agentRef)}`, async (event) => {
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

      await publish(agentRef, `response:${event.payload.id}`, responseEvent);

      console.log(`${id} responded: ${result.text}`);
    } catch (error) {
      console.error(`${id} error:`, error);
    }
  });

  console.log(`${id} started`);
  return agentRef;
}

main().catch(console.error);
