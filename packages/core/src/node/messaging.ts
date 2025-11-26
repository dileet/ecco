import type { NodeState } from './types';
import { verifyMessage } from '../services/auth';
import { addSubscription } from './state';
import { validateEvent, isValidEvent, type EccoEvent } from '../events';

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

    pubsub.addEventListener('message', async (evt: CustomEvent<unknown>) => {
      const detail = evt.detail;
      let incomingTopic: string | undefined;
      let incomingData: Uint8Array | undefined;

      if (typeof detail === 'object' && detail !== null) {
        const d = detail as Record<string, unknown>;

        const directTopic = typeof d.topic === 'string' ? d.topic : undefined;
        const directData = d.data instanceof Uint8Array ? d.data : undefined;

        if (directTopic && directData) {
          incomingTopic = directTopic;
          incomingData = directData;
        } else if (typeof d.msg === 'object' && d.msg !== null) {
          const m = d.msg as Record<string, unknown>;
          const msgTopic = typeof m.topic === 'string' ? m.topic : undefined;
          const msgData = m.data instanceof Uint8Array ? m.data : undefined;
          if (msgTopic && msgData) {
            incomingTopic = msgTopic;
            incomingData = msgData;
          }
        } else if (detail && typeof (detail as { topic?: unknown }).topic === 'string') {
          const msg = detail as { topic: string; data?: Uint8Array };
          incomingTopic = msg.topic;
          incomingData = msg.data;
        }
      }

      if (incomingTopic === topic && incomingData) {
        try {
          const rawData = JSON.parse(new TextDecoder().decode(incomingData));

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
      }
    });
  }

  return currentState;
}
