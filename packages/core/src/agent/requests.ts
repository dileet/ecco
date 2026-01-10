import type { Message, MessageType } from '../types'
import type { StateRef, NodeState } from '../node/types'
import { sendMessage, getLibp2pPeerId, subscribeToTopic } from '../node'
import { writeExpectedInvoice } from '../storage'
import { debug } from '../utils'
import type { EccoEvent } from '../events'
import type { AgentResponse } from '../orchestrator/types'

export interface RequestMethodsConfig {
  ref: StateRef<NodeState>
  agentId: string
}

export function createRequestMethod(config: RequestMethodsConfig) {
  const { ref, agentId } = config

  return async (
    peerId: string,
    prompt: string,
    options?: { signal?: AbortSignal }
  ): Promise<AgentResponse> => {
    if (!peerId || typeof peerId !== 'string' || peerId.trim() === '') {
      throw new Error('Invalid peerId: must be a non-empty string')
    }

    const requestMessage: Message = {
      id: crypto.randomUUID(),
      from: agentId,
      to: peerId,
      type: 'agent-request',
      payload: { prompt },
      timestamp: Date.now(),
    }

    const invoiceExpiresAt = Date.now() + 300000
    await writeExpectedInvoice(requestMessage.id, peerId, invoiceExpiresAt)

    debug('request', `Sending request ${requestMessage.id} from ${agentId} to ${peerId}`)

    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | undefined
      let aborted = false

      const cleanup = () => {
        if (unsubscribe) {
          unsubscribe()
        }
      }

      const onAbort = () => {
        if (aborted) return
        aborted = true
        debug('request', `ABORTED waiting for response to ${requestMessage.id}`)
        cleanup()
        reject(new Error('Request aborted'))
      }

      if (options?.signal?.aborted) {
        onAbort()
        return
      }

      options?.signal?.addEventListener('abort', onAbort, { once: true })

      const libp2pPeerId = getLibp2pPeerId(ref)
      debug('request', `Subscribing to topic peer:${libp2pPeerId}`)

      const handleResponse = (event: EccoEvent) => {
        if (aborted) return
        debug('request', `Received event type=${event.type}`)
        if (event.type !== 'message') return
        const response = event.payload as Message
        debug('request', `Message type=${response.type}, from=${response.from}`)
        if (response.type !== 'agent-response') return

        const responsePayload = response.payload as { requestId?: string; response?: unknown }
        debug('request', `Response requestId=${responsePayload?.requestId}, expected=${requestMessage.id}`)
        if (responsePayload?.requestId !== requestMessage.id) return

        debug('request', 'MATCHED! Resolving response')
        aborted = true
        cleanup()
        resolve({
          peer: {
            id: peerId,
            addresses: [],
            capabilities: [],
            lastSeen: Date.now(),
          },
          matchScore: 1,
          response: responsePayload?.response || response.payload,
          timestamp: Date.now(),
          latency: Date.now() - requestMessage.timestamp,
          success: true,
        })
      }

      if (libp2pPeerId) {
        unsubscribe = subscribeToTopic(ref, `peer:${libp2pPeerId}`, handleResponse)
      }

      sendMessage(ref, peerId, requestMessage).catch((error) => {
        if (aborted) return
        aborted = true
        cleanup()
        reject(error)
      })
    })
  }
}

export function createSendMethod(config: RequestMethodsConfig) {
  const { ref, agentId } = config

  return async (peerId: string, type: MessageType, payload: unknown): Promise<void> => {
    if (!peerId || typeof peerId !== 'string' || peerId.trim() === '') {
      throw new Error('Invalid peerId: must be a non-empty string')
    }

    const message: Message = {
      id: crypto.randomUUID(),
      from: agentId,
      to: peerId,
      type,
      payload,
      timestamp: Date.now(),
    }
    await sendMessage(ref, peerId, message)
  }
}
