import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import {
  ecco,
  stop,
  delay,
  findPeers,
  broadcastCapabilities,
  publish,
  initialOrchestratorState,
  type EccoNode,
  type MultiAgentConfig,
  type MessageEvent,
  type Message,
} from '@ecco/core';
import {
  createMultiAgentProvider,
  setupEmbeddingProvider,
  isAgentRequest,
} from '@ecco/ai-sdk';

const EMBEDDING_MODEL = openai.embedding('text-embedding-3-small');

function extractPeerId(addrs: string[]): string {
  if (addrs.length === 0) return '';
  const parts = addrs[0].split('/p2p/');
  return parts[1] ?? '';
}

function extractPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return '';

  const texts: string[] = [];
  for (const msg of prompt) {
    if (typeof msg !== 'object' || msg === null) continue;
    if (!('role' in msg) || msg.role !== 'user') continue;
    if (!('content' in msg)) continue;

    const content = msg.content;
    if (typeof content === 'string') {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && 'text' in part) {
          texts.push(String(part.text));
        }
      }
    }
  }
  return texts.join(' ');
}

function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= maxWidth) {
      currentLine = currentLine ? `${currentLine} ${word}` : word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word.length > maxWidth ? word.slice(0, maxWidth) : word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

function extractResponseText(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (parsed?.payload?.text) return parsed.payload.text;
  } catch {}
  return text;
}

async function createEmbeddingNode(name: string): Promise<EccoNode> {
  const node = await ecco(
    {
      discovery: ['dht', 'gossip'],
      nodeId: name,
      capabilities: [{ type: 'embedding', name: 'text-embedding-3-small', version: '1.0.0' }],
      transport: { websocket: { enabled: true } },
    },
    { onMessage: () => {} }
  );

  const libp2pPeerId = extractPeerId(node.addrs);

  setupEmbeddingProvider({
    nodeRef: node.ref,
    embeddingModel: EMBEDDING_MODEL,
    modelId: 'text-embedding-3-small',
    libp2pPeerId,
  });

  console.log(`[${name}] Embedding node started with peer ID: ${libp2pPeerId}`);
  console.log(`[${name}] Bootstrap address: ${node.addrs[0] ?? 'none'}`);
  return node;
}

async function createAgentNode(
  name: string,
  personality: string,
  bootstrapAddrs: string[]
): Promise<EccoNode> {
  let nodeRef: EccoNode['ref'] | null = null;
  let libp2pPeerId = '';

  const node = await ecco(
    {
      discovery: ['dht', 'gossip'],
      nodeId: name,
      capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
      transport: { websocket: { enabled: true } },
      bootstrap: { enabled: true, peers: bootstrapAddrs, timeout: 10000, minPeers: 1 },
    },
    {
      onMessage: async (msg: Message) => {
        if (!isAgentRequest(msg)) return;
        if (!nodeRef) return;

        const requestId = msg.id;
        const fromPeer = msg.from;
        const promptText = extractPromptText(msg.payload.options.prompt);

        console.log(`[${name}] Processing request: "${promptText.slice(0, 50)}..."`);

        try {
          const result = await generateText({
            model: openai('gpt-4o-mini'),
            system: `You are a helpful assistant with this personality: ${personality}. Keep responses concise (2-3 sentences).`,
            prompt: promptText,
          });

          const responseEvent: MessageEvent = {
            type: 'message',
            from: libp2pPeerId,
            to: fromPeer,
            payload: { text: result.text, finishReason: 'stop' },
            timestamp: Date.now(),
          };

          await publish(nodeRef, `response:${requestId}`, responseEvent);
          console.log(`[${name}] Sent response for request ${requestId.slice(0, 8)}...`);
        } catch (error) {
          console.error(`[${name}] Error:`, error);
          const errorEvent: MessageEvent = {
            type: 'message',
            from: libp2pPeerId,
            to: fromPeer,
            payload: { error: String(error) },
            timestamp: Date.now(),
          };
          await publish(nodeRef, `response:${requestId}`, errorEvent);
        }
      },
    }
  );

  nodeRef = node.ref;
  libp2pPeerId = extractPeerId(node.addrs);

  console.log(`[${name}] Agent node started with peer ID: ${libp2pPeerId}`);
  return node;
}

async function createCoordinatorNode(name: string, bootstrapAddrs: string[]): Promise<EccoNode> {
  const node = await ecco(
    {
      discovery: ['dht', 'gossip'],
      nodeId: name,
      capabilities: [{ type: 'coordinator', name: 'orchestrator', version: '1.0.0' }],
      transport: { websocket: { enabled: true } },
      bootstrap: { enabled: true, peers: bootstrapAddrs, timeout: 10000, minPeers: 1 },
    },
    { onMessage: () => {} }
  );

  console.log(`[${name}] Coordinator node started with ID: ${node.id}`);
  return node;
}

interface ConsensusMetadata {
  consensus?: { achieved: boolean; confidence: number };
  metrics?: { totalAgents: number; successfulAgents: number; averageLatency: number };
  agentResponses?: Array<{ agentId: string; success: boolean; latency: number }>;
}

async function main(): Promise<void> {
  console.log('=== Multi-Agent Consensus with Peer Embedding ===\n');

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is required');
    process.exit(1);
  }

  console.log('--- Starting Nodes ---\n');

  const embeddingNode = await createEmbeddingNode('embedding-provider');
  const bootstrapAddrs = embeddingNode.addrs;

  await delay(2000);

  const agents = await Promise.all([
    createAgentNode('agent-analytical', 'analytical and data-driven, focusing on facts and logic', bootstrapAddrs),
    createAgentNode('agent-creative', 'creative and imaginative, offering unique perspectives', bootstrapAddrs),
    createAgentNode('agent-practical', 'practical and straightforward, focusing on actionable advice', bootstrapAddrs),
  ]);

  const coordinator = await createCoordinatorNode('coordinator', bootstrapAddrs);

  console.log('\n--- Waiting for Network Formation ---\n');
  await delay(5000);

  await broadcastCapabilities(embeddingNode.ref);
  for (const agent of agents) {
    await broadcastCapabilities(agent.ref);
  }
  await broadcastCapabilities(coordinator.ref);

  await delay(3000);

  console.log('--- Network Status ---\n');
  const peers = await findPeers(coordinator.ref);
  console.log(`Coordinator sees ${peers.length} peers:`);
  for (const match of peers) {
    const caps = match.peer.capabilities.map((c) => `${c.type}:${c.name}`).join(', ');
    console.log(`  - ${match.peer.id.slice(0, 20)}... (${caps})`);
  }

  const multiAgentConfig: MultiAgentConfig = {
    selectionStrategy: 'all',
    aggregationStrategy: 'consensus-threshold',
    consensusThreshold: 0.6,
    timeout: 60000,
    allowPartialResults: true,
    semanticSimilarity: {
      enabled: true,
      method: 'peer-embedding',
      threshold: 0.75,
      requireExchange: false,
    },
    loadBalancing: {
      enabled: true,
      trackRequestCounts: true,
      preferLessLoaded: true,
    },
  };

  const provider = createMultiAgentProvider({
    nodeRef: coordinator.ref,
    orchestratorState: initialOrchestratorState,
    multiAgentConfig,
    enableMetadata: true,
  });

  const model = provider.languageModel('assistant');

  console.log('\n--- Running Multi-Agent Queries ---\n');

  const queries = [
    'What is the most important thing to consider when starting a new software project?',
    'How can teams improve their collaboration and productivity?',
  ];

  for (const query of queries) {
    console.log(`\n📝 Query: "${query}"\n`);
    console.log('Waiting for agent responses...\n');

    try {
      const result = await model.doGenerate({
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: query }] }],
      });

      const meta = (result.providerMetadata?.['ecco-multi-agent'] ?? {}) as ConsensusMetadata;

      console.log('╔' + '═'.repeat(58) + '╗');
      console.log('║' + ' '.repeat(20) + '✨ FINAL ANSWER ✨' + ' '.repeat(20) + '║');
      console.log('╠' + '═'.repeat(58) + '╣');

      if (result.content[0]?.type === 'text') {
        const wrappedLines = wrapText(result.content[0].text, 56);
        for (const line of wrappedLines) {
          console.log('║ ' + line.padEnd(56) + ' ║');
        }
      }

      console.log('╚' + '═'.repeat(58) + '╝');

      if (meta.consensus) {
        console.log(`\n📈 Confidence: ${(meta.consensus.confidence * 100).toFixed(1)}% | Agents: ${meta.metrics?.successfulAgents ?? 0}/${meta.metrics?.totalAgents ?? 0} | Latency: ${meta.metrics?.averageLatency?.toFixed(0) ?? 'N/A'}ms`);
      }

      console.log('\n' + '-'.repeat(60) + '\n');
    } catch (error) {
      console.error('Query failed:', error);
    }
  }

  console.log('\n--- Demonstrating Alternative Aggregation Strategies ---\n');

  const strategies: Array<{ name: string; config: MultiAgentConfig }> = [
    {
      name: 'Majority Vote',
      config: {
        ...multiAgentConfig,
        aggregationStrategy: 'majority-vote',
      },
    },
    {
      name: 'Best Score',
      config: {
        ...multiAgentConfig,
        aggregationStrategy: 'best-score',
        semanticSimilarity: { enabled: false },
      },
    },
    {
      name: 'Ensemble',
      config: {
        ...multiAgentConfig,
        aggregationStrategy: 'ensemble',
        semanticSimilarity: { enabled: false },
      },
    },
  ];

  for (const { name, config } of strategies) {
    console.log(`\n🔄 Strategy: ${name}\n`);

    const strategyProvider = createMultiAgentProvider({
      nodeRef: coordinator.ref,
      orchestratorState: initialOrchestratorState,
      multiAgentConfig: config,
      enableMetadata: true,
    });

    const strategyModel = strategyProvider.languageModel('assistant');

    try {
      const result = await strategyModel.doGenerate({
        prompt: [
          {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: 'Give a one-sentence tip for writing clean code.' }],
          },
        ],
      });

      const meta = (result.providerMetadata?.['ecco-multi-agent'] ?? {}) as ConsensusMetadata;

      if (result.content[0]?.type === 'text') {
        const text = result.content[0].text;
        if (name === 'Ensemble' && text.includes('[Agent')) {
          const agentMatches = text.match(/\[Agent [^\]]+\]: .+/g);
          if (agentMatches) {
            console.log('💡 Combined Agent Responses:');
            for (const match of agentMatches) {
              const shortId = match.slice(7, 15) + '...';
              const responseText = extractResponseText(match.split(']: ')[1]);
              console.log(`   • ${shortId}: ${responseText}`);
            }
          }
        } else {
          console.log(`💡 Answer: ${text}`);
        }
      }

      if (meta.consensus) {
        console.log(`   Confidence: ${(meta.consensus.confidence * 100).toFixed(1)}%`);
      }
    } catch (error) {
      console.error(`${name} failed:`, error);
    }
  }

  console.log('\n--- Load Statistics ---\n');
  const stats = model.getLoadStatistics();
  console.log('Load distribution:', JSON.stringify(stats, null, 2));

  console.log('\n--- Shutting Down ---\n');

  await stop(coordinator.ref);
  console.log('[coordinator] Stopped');

  for (const agent of agents) {
    await stop(agent.ref);
  }
  console.log('[agents] Stopped');

  await stop(embeddingNode.ref);
  console.log('[embedding-provider] Stopped');

  console.log('\nExample complete!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
