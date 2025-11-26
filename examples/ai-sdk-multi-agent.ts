import { config as loadEnv } from 'dotenv';
import { createInitialState, start, stop, subscribeToTopic, getId, getCapabilities, publish, type StateRef, type NodeState, type CapabilityAnnouncementEvent, type MessageEvent } from '@ecco/core';
import { createEccoProvider, isAgentRequest } from '@ecco/ai-sdk';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

loadEnv();

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type AgentKind = 'joke-agent' | 'fact-agent';

const args = process.argv.slice(2);
const mode = args[0] || 'all';

async function createLlmAgent(kind: AgentKind, systemPrompt: string): Promise<StateRef<NodeState>> {
  const nodeState = createInitialState({
    discovery: ['mdns', 'gossip'],
    capabilities: [
      {
        type: 'agent',
        name: kind,
        version: '1.0.0',
        metadata: {
          model: 'gpt-4o-mini',
        },
      },
    ],
  });

  const nodeRef = await start(nodeState);

  const announceCapabilities = async () => {
    const event: CapabilityAnnouncementEvent = {
      type: 'capability-announcement',
      peerId: getId(nodeRef),
      capabilities: getCapabilities(nodeRef),
      timestamp: Date.now(),
    };
    await publish(nodeRef, 'ecco:capabilities', event);
  };

  await announceCapabilities();
  console.log(`[${kind}] announced capabilities to network`);

  const processedMessages = new Set<string>();

  subscribeToTopic(nodeRef, 'network:requests', async (event) => {
    if (event.type !== 'message') return;

    const message = event.payload;
    if (typeof message !== 'object' || message === null || !('target' in message)) {
      return;
    }

    if (message.target !== kind) {
      return;
    }

    if ('seeker' in message) {
      console.log(`[${kind}] received seeker broadcast from ${message.seeker}`);
    }
  });

  subscribeToTopic(nodeRef, `peer:${getId(nodeRef)}`, async (event) => {
    if (event.type !== 'message') return;
    if (!isAgentRequest(event.payload)) {
      return;
    }

    const message = event.payload;

    if (message.payload.model !== kind) {
      return;
    }

    if (processedMessages.has(message.id)) {
      return;
    }

    processedMessages.add(message.id);

    const prompt = message.payload.options.prompt;
    const promptText = typeof prompt === 'string'
      ? prompt
      : JSON.stringify(prompt).substring(0, 100);

    console.log(`[${kind}] generating response for prompt: ${promptText}`);

    const response = await generateText({
      model: openai('gpt-4o-mini'),
      system: systemPrompt,
      prompt,
    });

    const responseEvent: MessageEvent = {
      type: 'message',
      from: getId(nodeRef),
      to: event.from,
      payload: {
        text: response.text,
        finishReason: 'stop',
        usage: response.usage,
      },
      timestamp: Date.now(),
    };

    await publish(nodeRef, `response:${message.id}`, responseEvent);
  });

  return nodeRef;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runJokeAgent() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in environment.');
    process.exit(1);
  }

  const jokeAgentRef = await createLlmAgent(
    'joke-agent',
    'You are a witty stand-up comedian who delivers concise programming jokes.'
  );

  console.log('\n=== Joke Agent Running ===');
  console.log('Waiting for requests...');
  console.log('Press Ctrl+C to stop.\n');

  process.on('SIGINT', async () => {
    console.log('\n\nShutting down joke agent...');
    await stop(jokeAgentRef);
    process.exit(0);
  });
}

async function runFactAgent() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in environment.');
    process.exit(1);
  }

  const factAgentRef = await createLlmAgent(
    'fact-agent',
    'You are an enthusiastic trivia expert who shares short surprising facts.'
  );

  console.log('\n=== Fact Agent Running ===');
  console.log('Waiting for requests...');
  console.log('Press Ctrl+C to stop.\n');

  process.on('SIGINT', async () => {
    console.log('\n\nShutting down fact agent...');
    await stop(factAgentRef);
    process.exit(0);
  });
}

async function runSeeker() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in environment.');
    process.exit(1);
  }

  const seekerState = createInitialState({
    discovery: ['mdns', 'gossip'],
    capabilities: [
      {
        type: 'agent',
        name: 'seeker',
        version: '1.0.0',
      },
    ],
  });

  const seekerRef = await start(seekerState);

  console.log('[seeker] waiting to discover agents...');
  await delay(3000);

  const provider = createEccoProvider({
    nodeRef: seekerRef,
  });

  console.log('[seeker] broadcasting interest in a joke agent');
  const jokeRequestEvent: MessageEvent = {
    type: 'message',
    from: getId(seekerRef),
    to: 'broadcast',
    payload: {
      seeker: getId(seekerRef),
      target: 'joke-agent',
      reason: 'need a programming joke',
    },
    timestamp: Date.now(),
  };
  await publish(seekerRef, 'network:requests', jokeRequestEvent);

  await delay(2000);

  const jokeResult = await generateText({
    model: provider.languageModel('joke-agent'),
    prompt: 'Tell me a quick programming joke about code reviews.',
  });

  console.log(`[seeker] joke agent replied: ${jokeResult.text}`);

  console.log('[seeker] broadcasting interest in a fact agent');
  const factRequestEvent: MessageEvent = {
    type: 'message',
    from: getId(seekerRef),
    to: 'broadcast',
    payload: {
      seeker: getId(seekerRef),
      target: 'fact-agent',
      reason: 'need a conversation starter',
    },
    timestamp: Date.now(),
  };
  await publish(seekerRef, 'network:requests', factRequestEvent);

  await delay(2000);

  const factResult = await generateText({
    model: provider.languageModel('fact-agent'),
    prompt: 'Share a surprising fact about space exploration.',
  });

  console.log(`[seeker] fact agent replied: ${factResult.text}`);

  console.log('\n=== Demo complete! ===');
  console.log('Seeker is still running. Press Ctrl+C to stop.\n');

  process.on('SIGINT', async () => {
    console.log('\n\nShutting down seeker...');
    await stop(seekerRef);
    process.exit(0);
  });
}

async function runAll() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in environment.');
    process.exit(1);
  }

  const jokeAgentRef = await createLlmAgent(
    'joke-agent',
    'You are a witty stand-up comedian who delivers concise programming jokes.'
  );

  const factAgentRef = await createLlmAgent(
    'fact-agent',
    'You are an enthusiastic trivia expert who shares short surprising facts.'
  );

  await delay(1000);

  const seekerState = createInitialState({
    discovery: ['mdns', 'gossip'],
    capabilities: [
      {
        type: 'agent',
        name: 'seeker',
        version: '1.0.0',
      },
    ],
  });

  const seekerRef = await start(seekerState);

  console.log('[seeker] waiting to discover agents...');
  await delay(3000);

  const provider = createEccoProvider({
    nodeRef: seekerRef,
  });

  console.log('[seeker] broadcasting interest in a joke agent');
  const jokeRequestEvent2: MessageEvent = {
    type: 'message',
    from: getId(seekerRef),
    to: 'broadcast',
    payload: {
      seeker: getId(seekerRef),
      target: 'joke-agent',
      reason: 'need a programming joke',
    },
    timestamp: Date.now(),
  };
  await publish(seekerRef, 'network:requests', jokeRequestEvent2);

  await delay(2000);

  const jokeResult = await generateText({
    model: provider.languageModel('joke-agent'),
    prompt: 'Tell me a quick programming joke about code reviews.',
  });

  console.log(`[seeker] joke agent replied: ${jokeResult.text}`);

  console.log('[seeker] broadcasting interest in a fact agent');
  const factRequestEvent2: MessageEvent = {
    type: 'message',
    from: getId(seekerRef),
    to: 'broadcast',
    payload: {
      seeker: getId(seekerRef),
      target: 'fact-agent',
      reason: 'need a conversation starter',
    },
    timestamp: Date.now(),
  };
  await publish(seekerRef, 'network:requests', factRequestEvent2);

  await delay(2000);

  const factResult = await generateText({
    model: provider.languageModel('fact-agent'),
    prompt: 'Share a surprising fact about space exploration.',
  });

  console.log(`[seeker] fact agent replied: ${factResult.text}`);

  console.log('\n=== Demo complete! ===');
  console.log('All nodes are still running and ready to accept requests.');
  console.log('Press Ctrl+C to stop.\n');

  process.on('SIGINT', async () => {
    console.log('\n\nShutting down all nodes...');
    await Promise.all([stop(jokeAgentRef), stop(factAgentRef), stop(seekerRef)]);
    process.exit(0);
  });
}

async function main() {
  console.log(`Mode: ${mode}\n`);

  switch (mode) {
    case 'joke-agent':
      await runJokeAgent();
      break;
    case 'fact-agent':
      await runFactAgent();
      break;
    case 'seeker':
      await runSeeker();
      break;
    case 'all':
      await runAll();
      break;
    default:
      console.error(`Unknown mode: ${mode}`);
      console.error('Usage: bun run examples/ai-sdk-multi-agent.ts [joke-agent|fact-agent|seeker|all]');
      process.exit(1);
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
