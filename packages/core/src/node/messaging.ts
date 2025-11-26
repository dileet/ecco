import type { NodeState } from './types';
import { z } from 'zod';
import { verifyMessage } from '../services/auth';
import { addSubscription } from './state';
import { validateEvent, isValidEvent, type EccoEvent } from '../events';

const PubSubMessageSchema = z.object({
  topic: z.string(),
  data: z.instanceof(Uint8Array),
});

const GossipsubMessageDetailSchema = z.object({
  msg: PubSubMessageSchema,
});

const MessageDetailSchema = z.union([PubSubMessageSchema, GossipsubMessageDetailSchema]);

function extractMessageData(detail: object): { topic: string; data: Uint8Array } | null {
  const result = MessageDetailSchema.safeParse(detail);
  if (!result.success) {
    return null;
  }
  if ('msg' in result.data) {
    return { topic: result.data.msg.topic, data: result.data.msg.data };
  }
  return { topic: result.data.topic, data: result.data.data };
}

export async function publish(state: NodeState, topic: string, event: EccoEvent): Promise<void> {
  if (!state.node?.services.pubsub) {
    throw new Error('Gossipsub not enabled');
  }

  const validatedEvent = validateEvent(event);
  const message = new TextEncoder().encode(JSON.stringify(validatedEvent));
  console.log(`[${state.id}] Publishing to topic ${topic}, event type: ${event.type}`);
  await state.node.services.pubsub.publish(topic, message);
}

export function subscribe(
  state: NodeState,
  topic: string,
  handler: (event: EccoEvent) => void
): NodeState {
  if (!state.node?.services.pubsub) {
    throw new Error('Gossipsub not enabled');
  }

  const messageAuth = state.messageAuth;
  let currentState = addSubscription(state, topic, handler);

  const existingHandlers = state.subscriptions[topic] || [];
  const isFirstSubscription = existingHandlers.length === 0;

  if (isFirstSubscription) {
    const pubsub = currentState.node?.services.pubsub;
    if (!pubsub) {
      throw new Error('Gossipsub not enabled');
    }

    console.log(`[${currentState.id}] Subscribing to topic: ${topic}`);
    pubsub.subscribe(topic);

    pubsub.addEventListener('message', async (evt) => {
      const detail = evt.detail;
      if (typeof detail !== 'object' || detail === null) {
        return;
      }

      const messageData = extractMessageData(detail);
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
  }

  return currentState;
}
