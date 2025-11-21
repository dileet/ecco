import type { NodeState } from './types';
import { Auth } from '../auth';
import { addSubscription } from './state-helpers';
import { EventBus, type EccoEvent } from '../events';
import { Effect } from 'effect';
import { getState } from './state-ref';

export async function publish(state: NodeState, topic: string, event: EccoEvent): Promise<void> {
  if (!state.node?.services.pubsub) {
    throw new Error('Gossipsub not enabled');
  }

  const validatedEvent = EventBus.validate(event);
  const message = new TextEncoder().encode(JSON.stringify(validatedEvent));
  console.log(`[${state.id}] Publishing to topic ${topic}, event type: ${event.type}`);
  await state.node.services.pubsub.publish(topic, message);
}

export function subscribe(state: NodeState, topic: string, handler: (event: EccoEvent) => void): NodeState {
  if (!state.node?.services.pubsub) {
    throw new Error('Gossipsub not enabled');
  }

  let currentState = state;

  const messageAuth = state.messageAuth;
  const stateRef = state._ref;

  currentState = addSubscription(currentState, topic, handler);

  if (currentState.subscriptions.get(topic)!.size === 1) {
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
            const { valid } = await Auth.verify(messageAuth, rawData);
            if (!valid) {
              console.warn('Received message with invalid signature, ignoring');
              return;
            }
          }

          if (!EventBus.isValid(rawData)) {
            console.warn('Received invalid event, ignoring');
            return;
          }

          const validatedEvent = EventBus.validate(rawData);

          if (stateRef) {
            const currentStateFromRef = await Effect.runPromise(getState(stateRef));
            const handlers = currentStateFromRef.subscriptions.get(topic);
            if (handlers) {
              handlers.forEach(h => h(validatedEvent));
            } else {
              console.warn(`[${currentState.id}] No handlers found for topic ${topic}`);
            }
          } else {
            const handlers = currentState.subscriptions.get(topic);
            if (handlers) {
              handlers.forEach(h => h(validatedEvent));
            } else {
              console.warn(`[${currentState.id}] No handlers found for topic ${topic}`);
            }
          }
        } catch (error) {
          console.error(`[${currentState.id}] Error processing message on topic ${topic}:`, error);
        }
      }
    });
  }

  return currentState;
}
