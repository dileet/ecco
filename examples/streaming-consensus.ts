import { streamText, embed } from 'ai'
import { openai } from '@ai-sdk/openai'
import {
  createAgent,
  subscribeToTopic,
  sendMessage,
  getLibp2pPeerId,
  delay,
  type Agent,
  type StreamGenerateFn,
  type EmbedFn,
  type Message,
  type EccoEvent,
} from '@ecco/core'

const EMBEDDING_MODEL = openai.embedding('text-embedding-3-small')
const MODEL = openai('gpt-4o-mini')

const embedFn: EmbedFn = async (texts) => {
  const results = await Promise.all(
    texts.map((text) => embed({ model: EMBEDDING_MODEL, value: text }))
  )
  return results.map((r) => Array.from(r.embedding))
}

const streamGenerate: StreamGenerateFn = async function* (options) {
  const result = streamText({
    model: options.model as Parameters<typeof streamText>[0]['model'],
    system: options.system,
    prompt: options.prompt,
  })
  for await (const chunk of result.textStream) {
    yield { text: chunk, tokens: 1 }
  }
}

interface AgentStreamResult {
  agentId: string
  agentName: string
  text: string
  latency: number
}

interface StreamingConsensusCallbacks {
  onAgentStart?: (agentId: string, agentName: string) => void
  onAgentChunk?: (agentId: string, agentName: string, chunk: string, fullTextSoFar: string) => void
  onAgentComplete?: (agentId: string, agentName: string, fullText: string, latency: number) => void
  onAllComplete?: (responses: AgentStreamResult[]) => void
}

interface StreamingConsensusOptions {
  coordinatorAgent: Agent
  targetAgents: Array<{ agent: Agent; name: string }>
  prompt: string
  callbacks: StreamingConsensusCallbacks
  timeout?: number
}

interface StreamingConsensusResult {
  responses: AgentStreamResult[]
  consensusText: string
  confidence: number
  averageLatency: number
}

interface StreamChunkPayload {
  requestId: string
  chunk: string
  partial: boolean
}

interface StreamCompletePayload {
  requestId: string
  text: string
  complete: boolean
}

interface AgentResponsePayload {
  requestId: string
  response: { text: string; finishReason: string }
}

async function streamingConsensusQuery(options: StreamingConsensusOptions): Promise<StreamingConsensusResult> {
  const { coordinatorAgent, targetAgents, prompt, callbacks, timeout = 60000 } = options

  const coordinatorPeerId = getLibp2pPeerId(coordinatorAgent.ref)
  if (!coordinatorPeerId) {
    throw new Error('Coordinator agent has no libp2p peer ID')
  }

  const agentStates = new Map<string, {
    name: string
    requestId: string
    chunks: string[]
    fullText: string
    completed: boolean
    startTime: number
    latency: number
  }>()

  const unsubscribers: Array<() => void> = []

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup()
      reject(new Error('Streaming consensus query timed out'))
    }, timeout)

    const cleanup = () => {
      clearTimeout(timeoutId)
      unsubscribers.forEach(unsub => unsub())
    }

    const checkAllComplete = () => {
      const allComplete = Array.from(agentStates.values()).every(s => s.completed)
      if (allComplete) {
        cleanup()

        const responses: AgentStreamResult[] = Array.from(agentStates.entries()).map(([agentId, state]) => ({
          agentId,
          agentName: state.name,
          text: state.fullText,
          latency: state.latency,
        }))

        callbacks.onAllComplete?.(responses)

        const consensusText = computeSimpleConsensus(responses)
        const averageLatency = responses.reduce((sum, r) => sum + r.latency, 0) / responses.length

        computeSemanticConfidence(responses).then(confidence => {
          resolve({
            responses,
            consensusText,
            confidence,
            averageLatency,
          })
        })
      }
    }

    const handleEvent = (event: EccoEvent) => {
      if (event.type !== 'message') return

      const payload = event.payload as Message
      const messageType = payload.type

      if (messageType === 'stream-chunk') {
        const chunkPayload = payload.payload as StreamChunkPayload
        const state = findStateByRequestId(chunkPayload.requestId)
        if (state) {
          state.chunks.push(chunkPayload.chunk)
          const fullTextSoFar = state.chunks.join('')
          callbacks.onAgentChunk?.(payload.from, state.name, chunkPayload.chunk, fullTextSoFar)
        }
      } else if (messageType === 'stream-complete') {
        const completePayload = payload.payload as StreamCompletePayload
        const state = findStateByRequestId(completePayload.requestId)
        if (state && !state.completed) {
          state.fullText = completePayload.text
          state.completed = true
          state.latency = Date.now() - state.startTime
          callbacks.onAgentComplete?.(payload.from, state.name, state.fullText, state.latency)
          checkAllComplete()
        }
      } else if (messageType === 'agent-response') {
        const responsePayload = payload.payload as AgentResponsePayload
        const state = findStateByRequestId(responsePayload.requestId)
        if (state && !state.completed) {
          state.fullText = responsePayload.response?.text ?? state.chunks.join('')
          state.completed = true
          state.latency = Date.now() - state.startTime
          callbacks.onAgentComplete?.(payload.from, state.name, state.fullText, state.latency)
          checkAllComplete()
        }
      }
    }

    const findStateByRequestId = (requestId: string) => {
      for (const state of agentStates.values()) {
        if (state.requestId === requestId) return state
      }
      return null
    }

    const unsub = subscribeToTopic(coordinatorAgent.ref, `peer:${coordinatorPeerId}`, handleEvent)
    unsubscribers.push(unsub)

    for (const { agent, name } of targetAgents) {
      const requestId = crypto.randomUUID()
      const startTime = Date.now()

      agentStates.set(agent.id, {
        name,
        requestId,
        chunks: [],
        fullText: '',
        completed: false,
        startTime,
        latency: 0,
      })

      callbacks.onAgentStart?.(agent.id, name)

      const message: Message = {
        id: requestId,
        from: coordinatorAgent.id,
        to: agent.id,
        type: 'agent-request',
        payload: { prompt },
        timestamp: startTime,
      }

      sendMessage(coordinatorAgent.ref, agent.id, message).catch(err => {
        console.error(`Failed to send to ${name}:`, err)
      })
    }
  })
}

function computeSimpleConsensus(responses: AgentStreamResult[]): string {
  if (responses.length === 0) return ''
  if (responses.length === 1) return responses[0].text

  const sortedByLength = [...responses].sort((a, b) => b.text.length - a.text.length)
  return sortedByLength[0].text
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

async function computeSemanticConfidence(responses: AgentStreamResult[]): Promise<number> {
  if (responses.length <= 1) return 1.0

  const embeddings = await embedFn(responses.map(r => r.text))

  let totalSimilarity = 0
  let pairCount = 0

  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      totalSimilarity += cosineSimilarity(embeddings[i], embeddings[j])
      pairCount++
    }
  }

  return pairCount > 0 ? totalSimilarity / pairCount : 1.0
}

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  white: '\x1b[37m',
}

const AGENT_COLORS: Record<string, string> = {
  analytical: COLORS.cyan,
  creative: COLORS.magenta,
  practical: COLORS.green,
}

function formatAgentBox(name: string, text: string, width: number = 60): string[] {
  const color = AGENT_COLORS[name] ?? COLORS.white
  const innerWidth = width - 4
  const title = ` ${name} `
  const titlePadding = Math.max(0, innerWidth - title.length)
  const leftPad = Math.floor(titlePadding / 2)
  const rightPad = titlePadding - leftPad

  const lines: string[] = []
  lines.push(`${color}┌${'─'.repeat(leftPad)}${title}${'─'.repeat(rightPad)}┐${COLORS.reset}`)

  const words = text.split(' ')
  let currentLine = ''
  for (const word of words) {
    if (currentLine.length + word.length + 1 <= innerWidth) {
      currentLine += (currentLine ? ' ' : '') + word
    } else {
      if (currentLine) {
        lines.push(`${color}│${COLORS.reset} ${currentLine.padEnd(innerWidth - 1)}${color}│${COLORS.reset}`)
      }
      currentLine = word
    }
  }
  if (currentLine) {
    lines.push(`${color}│${COLORS.reset} ${currentLine.padEnd(innerWidth - 1)}${color}│${COLORS.reset}`)
  }

  lines.push(`${color}└${'─'.repeat(innerWidth)}┘${COLORS.reset}`)
  return lines
}

async function main(): Promise<void> {
  console.log(`${COLORS.bold}=== Streaming Multi-Agent Consensus ===${COLORS.reset}\n`)

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is required')
    process.exit(1)
  }

  console.log(`${COLORS.dim}--- Creating Agents ---${COLORS.reset}\n`)

  const analyticalAgent = await createAgent({
    name: 'agent-analytical',
    systemPrompt: 'You are an analytical and data-driven assistant, focusing on facts and logic. Keep responses concise (2-3 sentences).',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    model: MODEL,
    streamGenerateFn: streamGenerate,
  })
  console.log(`${AGENT_COLORS.analytical}[analytical]${COLORS.reset} Agent started`)

  await delay(500)

  const creativeAgent = await createAgent({
    name: 'agent-creative',
    network: analyticalAgent.addrs,
    systemPrompt: 'You are a creative and imaginative assistant, offering unique perspectives. Keep responses concise (2-3 sentences).',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    model: MODEL,
    streamGenerateFn: streamGenerate,
  })
  console.log(`${AGENT_COLORS.creative}[creative]${COLORS.reset} Agent started`)

  await delay(500)

  const practicalAgent = await createAgent({
    name: 'agent-practical',
    network: analyticalAgent.addrs,
    systemPrompt: 'You are a practical and straightforward assistant, focusing on actionable advice. Keep responses concise (2-3 sentences).',
    capabilities: [{ type: 'agent', name: 'assistant', version: '1.0.0' }],
    model: MODEL,
    streamGenerateFn: streamGenerate,
  })
  console.log(`${AGENT_COLORS.practical}[practical]${COLORS.reset} Agent started`)

  await delay(500)

  const coordinatorAgent = await createAgent({
    name: 'coordinator',
    network: analyticalAgent.addrs,
    capabilities: [{ type: 'coordinator', name: 'streaming-orchestrator', version: '1.0.0' }],
  })
  console.log(`${COLORS.dim}[coordinator]${COLORS.reset} Started`)

  await delay(2000)

  const query = 'What is the most important skill for a software developer to learn?'
  console.log(`\n${COLORS.bold}Query:${COLORS.reset} "${query}"\n`)

  const agentTexts: Record<string, string> = {
    analytical: '',
    creative: '',
    practical: '',
  }

  const agentComplete: Record<string, boolean> = {
    analytical: false,
    creative: false,
    practical: false,
  }

  const renderAll = () => {
    process.stdout.write('\x1b[2J\x1b[H')
    console.log(`${COLORS.bold}=== Streaming Multi-Agent Consensus ===${COLORS.reset}\n`)
    console.log(`${COLORS.bold}Query:${COLORS.reset} "${query}"\n`)

    for (const name of ['analytical', 'creative', 'practical']) {
      const text = agentTexts[name] || '...'
      const displayText = agentComplete[name] ? text : text + '█'
      const lines = formatAgentBox(name, displayText)
      lines.forEach(line => console.log(line))
      console.log()
    }
  }

  const result = await streamingConsensusQuery({
    coordinatorAgent,
    targetAgents: [
      { agent: analyticalAgent, name: 'analytical' },
      { agent: creativeAgent, name: 'creative' },
      { agent: practicalAgent, name: 'practical' },
    ],
    prompt: query,
    callbacks: {
      onAgentStart: (_agentId, name) => {
        agentTexts[name] = ''
        renderAll()
      },
      onAgentChunk: (_agentId, name, _chunk, fullText) => {
        agentTexts[name] = fullText
        renderAll()
      },
      onAgentComplete: (_agentId, name, fullText, latency) => {
        agentTexts[name] = fullText
        agentComplete[name] = true
        renderAll()
        console.log(`${COLORS.dim}[${name}] Complete in ${latency}ms${COLORS.reset}`)
      },
      onAllComplete: () => {
        console.log(`\n${COLORS.dim}All agents complete${COLORS.reset}`)
      },
    },
    timeout: 60000,
  })

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`${COLORS.bold}${COLORS.yellow}CONSENSUS${COLORS.reset} (${(result.confidence * 100).toFixed(1)}% confidence)`)
  console.log()
  console.log(result.consensusText)
  console.log()
  console.log(`${COLORS.dim}Agents: ${result.responses.length}/${result.responses.length} | Avg Latency: ${result.averageLatency.toFixed(0)}ms${COLORS.reset}`)

  console.log(`\n${COLORS.dim}--- Shutting Down ---${COLORS.reset}\n`)

  await coordinatorAgent.stop()
  await analyticalAgent.stop()
  await creativeAgent.stop()
  await practicalAgent.stop()

  console.log('Example complete!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
