import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { NodeState, StateRef } from '../node/types'
import { subscribeToTopic, getId, publish, findPeers, getState, setState, getPeer, addPeer, updatePeer, registerCleanup, getLibp2pPeerId } from '../node'
import type { CapabilityQuery, PeerInfo } from '../types'
import { MessageEventSchema, type MessageEvent } from '../events'
import { withTimeout } from '../utils'
import type { GenerateFn, StreamGenerateFn } from '../agent/types'

export const GenerationRequestSchema = z.object({
  type: z.literal('generation-request'),
  requestId: z.string(),
  prompt: z.string(),
  system: z.string().optional(),
  model: z.string().optional(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  stream: z.boolean().optional(),
})

export const GenerationResponseSchema = z.object({
  type: z.literal('generation-response'),
  requestId: z.string(),
  text: z.string(),
  model: z.string(),
  tokens: z.number().optional(),
  finishReason: z.string().optional(),
})

export const GenerationStreamChunkSchema = z.object({
  type: z.literal('generation-stream-chunk'),
  requestId: z.string(),
  text: z.string(),
  tokens: z.number().optional(),
})

export const GenerationStreamCompleteSchema = z.object({
  type: z.literal('generation-stream-complete'),
  requestId: z.string(),
  totalTokens: z.number().optional(),
  finishReason: z.string().optional(),
})

export type GenerationRequest = z.infer<typeof GenerationRequestSchema>
export type GenerationResponse = z.infer<typeof GenerationResponseSchema>
export type GenerationStreamChunk = z.infer<typeof GenerationStreamChunkSchema>
export type GenerationStreamComplete = z.infer<typeof GenerationStreamCompleteSchema>

function calculatePeerScore(peer: PeerInfo): number {
  const balance = (peer.servicesProvided || 0) - (peer.servicesConsumed || 0)
  const balanceScore = Math.max(0, Math.min(1, (balance + 10) / 20))
  const reputationScore = peer.reputation ? Math.min(1, peer.reputation / 100) : 0.5
  return reputationScore * 0.7 + balanceScore * 0.3
}

function shouldUsePeerForGeneration(peer: PeerInfo, requireExchange: boolean): boolean {
  if (!requireExchange) {
    return true
  }
  const servicesProvided = peer.servicesProvided || 0
  const servicesConsumed = peer.servicesConsumed || 0
  return servicesProvided > servicesConsumed
}

export function selectGenerationPeer(
  peers: PeerInfo[],
  requireExchange: boolean
): PeerInfo | null {
  const filteredPeers = peers.filter((peer) => shouldUsePeerForGeneration(peer, requireExchange))

  if (filteredPeers.length === 0) {
    return null
  }

  const peerScores = filteredPeers.map((peer) => ({
    peer,
    score: calculatePeerScore(peer),
  }))

  peerScores.sort((a, b) => b.score - a.score)
  return peerScores[0]?.peer ?? null
}

function updatePeerServiceProvided(ref: StateRef<NodeState>, peerId: string): void {
  const state = getState(ref)
  const peer = getPeer(state, peerId)
  if (!peer) {
    return
  }
  setState(ref, updatePeer(state, peerId, {
    servicesProvided: (peer.servicesProvided || 0) + 1,
  }))
}

function updatePeerServiceConsumed(ref: StateRef<NodeState>, peerId: string): void {
  const state = getState(ref)
  const existing = getPeer(state, peerId)
  if (existing) {
    setState(ref, updatePeer(state, peerId, {
      servicesConsumed: (existing.servicesConsumed || 0) + 1,
      lastSeen: Date.now(),
    }))
  } else {
    setState(ref, addPeer(state, {
      id: peerId,
      addresses: [],
      capabilities: [],
      lastSeen: Date.now(),
      servicesConsumed: 1,
    }))
  }
}

export interface GenerationConfig {
  requireExchange?: boolean
  model?: string
  preferredPeers?: string[]
  timeout?: number
  system?: string
  maxTokens?: number
  temperature?: number
}

export async function requestGeneration(
  ref: StateRef<NodeState>,
  prompt: string,
  config: GenerationConfig = {}
): Promise<string> {
  const timeoutMs = config.timeout ?? 60000

  const query: CapabilityQuery = {
    requiredCapabilities: [{ type: 'model' }],
    preferredPeers: config.preferredPeers,
  }

  const matches = await findPeers(ref, query)

  if (matches.length === 0 && config.preferredPeers && config.preferredPeers.length > 0) {
    const targetPeerId = config.preferredPeers[0]!
    const response = await sendGenerationRequest(ref, targetPeerId, prompt, config, timeoutMs)
    updatePeerServiceConsumed(ref, targetPeerId)
    return response.text
  }

  if (matches.length === 0) {
    throw new Error('No generation-capable peers found')
  }

  const selectedPeer = selectGenerationPeer(
    matches.map((m) => m.peer),
    config.requireExchange || false
  )

  if (!selectedPeer) {
    throw new Error('No eligible generation peers (check service exchange balance)')
  }

  const response = await sendGenerationRequest(ref, selectedPeer.id, prompt, config, timeoutMs)
  updatePeerServiceConsumed(ref, selectedPeer.id)
  return response.text
}

async function sendGenerationRequest(
  ref: StateRef<NodeState>,
  targetPeerId: string,
  prompt: string,
  config: GenerationConfig,
  timeoutMs: number
): Promise<GenerationResponse> {
  const requestId = `generation-${Date.now()}-${randomUUID()}`
  const request: GenerationRequest = {
    type: 'generation-request',
    requestId,
    prompt,
    system: config.system,
    model: config.model,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    stream: false,
  }

  const cleanupFunctions: Array<() => void> = []

  const responsePromise = new Promise<GenerationResponse>((resolve) => {
    const responseHandler = (response: GenerationResponse) => {
      resolve(response)
    }

    cleanupFunctions.push(
      subscribeToTopic(ref, `generation-response:${requestId}`, (event) => {
        if (event.type === 'message') {
          const parsed = GenerationResponseSchema.safeParse(event.payload)
          if (parsed.success) {
            responseHandler(parsed.data)
          }
        }
      })
    )

    cleanupFunctions.push(
      subscribeToTopic(ref, `peer:${getId(ref)}`, (event) => {
        if (event.type === 'message') {
          const parsed = GenerationResponseSchema.safeParse(event.payload)
          if (parsed.success && parsed.data.requestId === requestId) {
            responseHandler(parsed.data)
          }
        }
      })
    )

    const message = {
      id: requestId,
      from: getId(ref),
      to: targetPeerId,
      type: 'generation-request' as const,
      payload: request,
      timestamp: Date.now(),
    }
    const messageEvent: MessageEvent = {
      type: 'message',
      from: getId(ref),
      to: targetPeerId,
      payload: message,
      timestamp: Date.now(),
    }
    publish(ref, `peer:${targetPeerId}`, messageEvent)
  })

  try {
    return await withTimeout(responsePromise, timeoutMs, 'Generation request timeout')
  } finally {
    for (const cleanup of cleanupFunctions) {
      cleanup()
    }
  }
}

export async function* streamGeneration(
  ref: StateRef<NodeState>,
  prompt: string,
  config: GenerationConfig = {}
): AsyncGenerator<{ text: string; tokens?: number }> {
  const timeoutMs = config.timeout ?? 60000

  const query: CapabilityQuery = {
    requiredCapabilities: [{ type: 'model' }],
    preferredPeers: config.preferredPeers,
  }

  const matches = await findPeers(ref, query)
  let targetPeerId: string

  if (matches.length === 0 && config.preferredPeers && config.preferredPeers.length > 0) {
    targetPeerId = config.preferredPeers[0]!
  } else if (matches.length === 0) {
    throw new Error('No generation-capable peers found')
  } else {
    const selectedPeer = selectGenerationPeer(
      matches.map((m) => m.peer),
      config.requireExchange || false
    )

    if (!selectedPeer) {
      throw new Error('No eligible generation peers (check service exchange balance)')
    }
    targetPeerId = selectedPeer.id
  }

  const requestId = `generation-${Date.now()}-${randomUUID()}`
  const request: GenerationRequest = {
    type: 'generation-request',
    requestId,
    prompt,
    system: config.system,
    model: config.model,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    stream: true,
  }

  const chunks: Array<{ text: string; tokens?: number }> = []
  let complete = false
  let resolveNext: (() => void) | null = null
  const unsubscribers: Array<() => void> = []

  const handleStreamEvent = (event: unknown) => {
    const parsed = MessageEventSchema.safeParse(event)
    if (!parsed.success) return
    if (parsed.data.type !== 'message') return

    const chunkParsed = GenerationStreamChunkSchema.safeParse(parsed.data.payload)
    if (chunkParsed.success && chunkParsed.data.requestId === requestId) {
      chunks.push({ text: chunkParsed.data.text, tokens: chunkParsed.data.tokens })
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
    }

    const completeParsed = GenerationStreamCompleteSchema.safeParse(parsed.data.payload)
    if (completeParsed.success && completeParsed.data.requestId === requestId) {
      complete = true
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
    }
  }

  unsubscribers.push(subscribeToTopic(ref, `peer:${getId(ref)}`, handleStreamEvent))

  const libp2pPeerId = getLibp2pPeerId(ref)
  if (libp2pPeerId) {
    unsubscribers.push(subscribeToTopic(ref, `peer:${libp2pPeerId}`, handleStreamEvent))
  }

  const message = {
    id: requestId,
    from: getId(ref),
    to: targetPeerId,
    type: 'generation-request' as const,
    payload: request,
    timestamp: Date.now(),
  }
  const messageEvent: MessageEvent = {
    type: 'message',
    from: getId(ref),
    to: targetPeerId,
    payload: message,
    timestamp: Date.now(),
  }
  publish(ref, `peer:${targetPeerId}`, messageEvent)

  try {
    const startTime = Date.now()
    while (!complete) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error('Stream generation timeout')
      }

      while (chunks.length > 0) {
        yield chunks.shift()!
      }

      if (!complete && chunks.length === 0) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve
          setTimeout(resolve, 100)
        })
      }
    }

    while (chunks.length > 0) {
      yield chunks.shift()!
    }

    updatePeerServiceConsumed(ref, targetPeerId)
  } finally {
    for (const unsub of unsubscribers) {
      unsub()
    }
  }
}

export interface GenerationProviderConfig {
  nodeRef: StateRef<NodeState>
  generateFn: GenerateFn
  streamGenerateFn?: StreamGenerateFn
  modelId: string
  libp2pPeerId?: string
}

async function processGenerationRequest(
  config: GenerationProviderConfig,
  event: MessageEvent,
  request: GenerationRequest
): Promise<void> {
  const { nodeRef, generateFn, streamGenerateFn, modelId } = config

  if (request.stream && streamGenerateFn) {
    const generator = streamGenerateFn({
      model: modelId,
      system: request.system ?? 'You are a helpful assistant.',
      prompt: request.prompt,
    })

    let totalTokens = 0
    let chunkIndex = 0
    for await (const chunk of generator) {
      totalTokens += chunk.tokens ?? 1
      const chunkId = `${request.requestId}-chunk-${chunkIndex++}`
      const chunkEvent = {
        id: chunkId,
        type: 'message' as const,
        from: getId(nodeRef),
        to: event.from,
        payload: {
          type: 'generation-stream-chunk',
          requestId: request.requestId,
          text: chunk.text,
          tokens: chunk.tokens,
        },
        timestamp: Date.now(),
      }
      await publish(nodeRef, `peer:${event.from}`, chunkEvent)
    }

    const completeEvent = {
      id: `${request.requestId}-complete`,
      type: 'message' as const,
      from: getId(nodeRef),
      to: event.from,
      payload: {
        type: 'generation-stream-complete',
        requestId: request.requestId,
        totalTokens,
        finishReason: 'stop',
      },
      timestamp: Date.now(),
    }
    await publish(nodeRef, `peer:${event.from}`, completeEvent)
  } else {
    const result = await generateFn({
      model: modelId,
      system: request.system ?? 'You are a helpful assistant.',
      prompt: request.prompt,
    })

    const responseEvent: MessageEvent = {
      type: 'message',
      from: getId(nodeRef),
      to: event.from,
      payload: {
        type: 'generation-response',
        requestId: request.requestId,
        text: result.text,
        model: modelId,
        finishReason: 'stop',
      },
      timestamp: Date.now(),
    }
    await publish(nodeRef, `peer:${event.from}`, responseEvent)
  }

  updatePeerServiceProvided(nodeRef, event.from)
}

export function setupGenerationProvider(config: GenerationProviderConfig): void {
  const { nodeRef, libp2pPeerId } = config

  const handleGenerationRequest = async (event: unknown): Promise<void> => {
    const messageEvent = MessageEventSchema.safeParse(event)
    if (!messageEvent.success) return

    const eventPayload = messageEvent.data.payload as { type?: string; payload?: unknown; from?: string }
    const requestPayload = eventPayload?.type === 'generation-request' ? eventPayload.payload : eventPayload
    const eventFrom = eventPayload?.from ?? messageEvent.data.from

    const request = GenerationRequestSchema.safeParse(requestPayload)
    if (!request.success) return

    const effectiveEvent = { ...messageEvent.data, from: eventFrom }

    try {
      await processGenerationRequest(config, effectiveEvent, request.data)
    } catch (error) {
      console.error(`[${getId(nodeRef)}] Generation error:`, error)
    }
  }

  const unsubscribe1 = subscribeToTopic(nodeRef, `peer:${getId(nodeRef)}`, handleGenerationRequest)
  registerCleanup(nodeRef, unsubscribe1)

  if (libp2pPeerId) {
    const unsubscribe2 = subscribeToTopic(nodeRef, `peer:${libp2pPeerId}`, handleGenerationRequest)
    registerCleanup(nodeRef, unsubscribe2)
  }
}
