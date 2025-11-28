import type { NodeState, StateRef } from './types';
import type { Message } from '../types';
import { z } from 'zod';
import { verifyMessage, signMessage } from '../services/auth';
import { addSubscription, getState, updateState } from './state';
import { validateEvent, isValidEvent, type EccoEvent } from '../events';
import {
  serializeTopicMessage,
  subscribeToTopic as bridgeSubscribeToTopic,
  createMessage,
} from '../transport/message-bridge';

const subscribedTopics = new Map<string, Set<string>>();

const PubSubMessageSchema = z.object({
  topic: z.string(),
  data: z.instanceof(Uint8Array),
});

const MessageDetailSchema = z.union([
  z.object({ msg: PubSubMessageSchema }).transform(({ msg }) => msg),
  PubSubMessageSchema,
]);

function extractMessageData(detail: unknown): z.infer<typeof PubSubMessageSchema> | null {
  const result = MessageDetailSchema.safeParse(detail);
  return result.success ? result.data : null;
}

function hasTransportLayer(state: NodeState): boolean {
  return !!(state.transport && state.messageBridge);
}

export async function publish(state: NodeState, topic: string, event: EccoEvent): Promise<void> {
  const validatedEvent = validateEvent(event);

  if (hasTransportLayer(state)) {
    const bridgeMessage = createMessage(
      state.messageBridge!,
      'broadcast',
      'gossip',
      { topic, event: validatedEvent }
    );

    const transportMessage = await serializeTopicMessage(
      state.messageBridge!,
      topic,
      bridgeMessage
    );

    for (const adapter of state.transport!.adapters.values()) {
      if (adapter.state === 'connected') {
        await adapter.broadcast(transportMessage);
      }
    }
    return;
  }

  if (state.node?.services.pubsub) {
    const message = new TextEncoder().encode(JSON.stringify(validatedEvent));
    await state.node.services.pubsub.publish(topic, message);
    return;
  }

  throw new Error('No messaging transport available');
}

export async function publishDirect(
  state: NodeState,
  peerId: string,
  message: Message
): Promise<void> {
  let messageToSend = message;
  if (state.messageAuth) {
    messageToSend = await signMessage(state.messageAuth, message);
  }

  const messageEvent: EccoEvent = {
    type: 'message',
    from: messageToSend.from,
    to: messageToSend.to,
    payload: messageToSend,
    timestamp: Date.now(),
  };

  if (hasTransportLayer(state)) {
    await publish(state, `peer:${peerId}`, messageEvent);
    return;
  }

  if (state.node?.services.pubsub) {
    const encoded = new TextEncoder().encode(JSON.stringify(messageEvent));
    await state.node.services.pubsub.publish(`peer:${peerId}`, encoded);
    return;
  }

  throw new Error('No messaging transport available');
}

export function subscribeWithRef(
  stateRef: StateRef<NodeState>,
  topic: string,
  handler: (event: EccoEvent) => void
): void {
  const state = getState(stateRef);

  updateState(stateRef, (s) => addSubscription(s, topic, handler));

  if (!subscribedTopics.has(state.id)) {
    subscribedTopics.set(state.id, new Set());
  }

  const nodeTopics = subscribedTopics.get(state.id)!;
  const isFirstSubscription = !nodeTopics.has(topic);

  if (!isFirstSubscription) {
    return;
  }

  nodeTopics.add(topic);

  if (hasTransportLayer(state)) {
    updateState(stateRef, (s) => {
      if (!s.messageBridge) return s;

      return {
        ...s,
        messageBridge: bridgeSubscribeToTopic(
          s.messageBridge,
          topic,
          (message: Message) => {
            try {
              const payload = message.payload as { topic?: string; event?: EccoEvent };

              if (payload?.event && isValidEvent(payload.event)) {
                const validatedEvent = validateEvent(payload.event);
                const latestState = getState(stateRef);
                const handlers = latestState.subscriptions[topic];

                if (handlers && handlers.length > 0) {
                  handlers.forEach((h) => h(validatedEvent));
                }
              }
            } catch (error) {
              const currentState = getState(stateRef);
              console.error(`[${currentState.id}] Error processing transport message on topic ${topic}:`, error);
            }
          }
        ),
      };
    });
    return;
  }

  if (state.node?.services.pubsub) {
    const pubsub = state.node.services.pubsub;
    pubsub.subscribe(topic);

    pubsub.addEventListener('message', async (evt) => {
      const messageData = extractMessageData(evt.detail);
      if (!messageData || messageData.topic !== topic) {
        return;
      }

      try {
        const rawData = JSON.parse(new TextDecoder().decode(messageData.data));
        const currentState = getState(stateRef);

        if (currentState.messageAuth && rawData.signature) {
          const { valid } = await verifyMessage(currentState.messageAuth, rawData);
          if (!valid) {
            console.warn('Received message with invalid signature, ignoring');
            return;
          }
        }

        if (!isValidEvent(rawData)) {
          console.warn('Received invalid event, ignoring');
          return;
        }

        const validatedEvent = validateEvent(rawData);
        const latestState = getState(stateRef);
        const handlers = latestState.subscriptions[topic];

        if (handlers && handlers.length > 0) {
          handlers.forEach((h) => h(validatedEvent));
        }
      } catch (error) {
        const currentState = getState(stateRef);
        console.error(`[${currentState.id}] Error processing pubsub message on topic ${topic}:`, error);
      }
    });
    return;
  }

  throw new Error('No messaging transport available');
}

export function subscribe(
  state: NodeState,
  topic: string,
  handler: (event: EccoEvent) => void
): NodeState {
  const messageAuth = state.messageAuth;
  let currentState = addSubscription(state, topic, handler);

  const existingHandlers = state.subscriptions[topic] || [];
  const isFirstSubscription = existingHandlers.length === 0;

  if (isFirstSubscription) {
    if (currentState.node?.services.pubsub) {
      const pubsub = currentState.node.services.pubsub;
      pubsub.subscribe(topic);

      pubsub.addEventListener('message', async (evt) => {
        const messageData = extractMessageData(evt.detail);
        if (!messageData || messageData.topic !== topic) {
          return;
        }

        try {
          const rawData = JSON.parse(new TextDecoder().decode(messageData.data));

          if (messageAuth && rawData.signature) {
            const { valid } = await verifyMessage(messageAuth, rawData);
            if (!valid) {
              console.warn('Received message with invalid signature, ignoring');
              return;
            }
          }

          if (!isValidEvent(rawData)) {
            console.warn('Received invalid event, ignoring');
            return;
          }

          const validatedEvent = validateEvent(rawData);

          const handlers = currentState.subscriptions[topic];
          if (handlers && handlers.length > 0) {
            handlers.forEach((h) => h(validatedEvent));
          } else {
            console.warn(`[${currentState.id}] No handlers found for topic ${topic}`);
          }
        } catch (error) {
          console.error(`[${currentState.id}] Error processing message on topic ${topic}:`, error);
        }
      });
    } else if (currentState.messageBridge) {
      currentState = {
        ...currentState,
        messageBridge: bridgeSubscribeToTopic(
          currentState.messageBridge,
          topic,
          (message: Message) => {
            try {
              const payload = message.payload as { topic?: string; event?: EccoEvent };

              if (payload?.event && isValidEvent(payload.event)) {
                const validatedEvent = validateEvent(payload.event);
                const handlers = currentState.subscriptions[topic];
                if (handlers && handlers.length > 0) {
                  handlers.forEach((h) => h(validatedEvent));
                }
              }
            } catch (error) {
              console.error(`[${currentState.id}] Error processing bridge message on topic ${topic}:`, error);
            }
          }
        ),
      };
    } else {
      throw new Error('No messaging transport available (neither pubsub nor message bridge)');
    }
  }

  return currentState;
}
