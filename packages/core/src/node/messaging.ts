import type { NodeState, StateRef } from './types';
import type { Message } from '../types';
import { z } from 'zod';
import { verifyMessage, signMessage } from '../services/auth';
import { addSubscription, removeSubscription, getState, updateState } from './state';
import { validateEvent, isValidEvent, type EccoEvent } from '../events';
import {
  serializeTopicMessage,
  serializeMessage,
  subscribeToTopic as bridgeSubscribeToTopic,
  createMessage,
} from '../transport/message-bridge';

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

function checkAndRotateDeduplicator(stateRef: StateRef<NodeState>): void {
  const state = getState(stateRef);
  if (state.floodProtection.deduplicator.shouldRotate()) {
    state.floodProtection.deduplicator.rotate();
  }
}

function isMessageDuplicate(state: NodeState, messageId: string): boolean {
  return state.floodProtection.deduplicator.isDuplicate(messageId);
}

function markMessageSeen(state: NodeState, messageId: string): void {
  state.floodProtection.deduplicator.markSeen(messageId);
}

function checkRateLimit(state: NodeState, peerId: string): boolean {
  return state.floodProtection.rateLimiter.checkAndConsume(peerId);
}

function isSubscribedToTopic(state: NodeState, topic: string): boolean {
  return state.subscribedTopics.has(topic) || Object.hasOwn(state.subscriptions, topic);
}

function getTopicSubscribers(state: NodeState, topic: string): Set<string> {
  return state.floodProtection.topicSubscribers.get(topic) ?? new Set();
}

function addTopicSubscriber(stateRef: StateRef<NodeState>, topic: string, peerId: string): void {
  updateState(stateRef, (s) => {
    const subscribers = new Set(s.floodProtection.topicSubscribers.get(topic) ?? []);
    subscribers.add(peerId);
    const newTopicSubscribers = new Map(s.floodProtection.topicSubscribers);
    newTopicSubscribers.set(topic, subscribers);
    return {
      ...s,
      floodProtection: {
        ...s.floodProtection,
        topicSubscribers: newTopicSubscribers,
      },
    };
  });
}

function removeTopicSubscriber(stateRef: StateRef<NodeState>, topic: string, peerId: string): void {
  updateState(stateRef, (s) => {
    const subscribers = s.floodProtection.topicSubscribers.get(topic);
    if (!subscribers) return s;
    const newSubscribers = new Set(subscribers);
    newSubscribers.delete(peerId);
    const newTopicSubscribers = new Map(s.floodProtection.topicSubscribers);
    if (newSubscribers.size === 0) {
      newTopicSubscribers.delete(topic);
    } else {
      newTopicSubscribers.set(topic, newSubscribers);
    }
    return {
      ...s,
      floodProtection: {
        ...s.floodProtection,
        topicSubscribers: newTopicSubscribers,
      },
    };
  });
}

export async function publish(state: NodeState, topic: string, event: EccoEvent): Promise<void> {
  const validatedEvent = validateEvent(event);

  if (state.node?.services.pubsub) {
    const message = new TextEncoder().encode(JSON.stringify(validatedEvent));
    await state.node.services.pubsub.publish(topic, message);
    return;
  }

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

    const subscribers = getTopicSubscribers(state, topic);
    
    if (subscribers.size > 0) {
      for (const adapter of state.transport!.adapters.values()) {
        if (adapter.state === 'connected') {
          const connectedPeers = adapter.getConnectedPeers();
          for (const peer of connectedPeers) {
            if (subscribers.has(peer.id)) {
              await adapter.send(peer.id, transportMessage);
            }
          }
        }
      }
    } else {
      for (const adapter of state.transport!.adapters.values()) {
        if (adapter.state === 'connected') {
          await adapter.broadcast(transportMessage);
        }
      }
    }
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

  if (!hasTransportLayer(state) || !state.transport) {
    throw new Error('No transport available for direct messaging');
  }

  const transportMessage = await serializeMessage(
    state.messageBridge!,
    messageToSend
  );

  const errors: Error[] = [];
  
  for (const adapter of state.transport.adapters.values()) {
    if (adapter.state === 'connected') {
      try {
        await adapter.send(peerId, transportMessage);
        return;
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  throw new Error(`Failed to send direct message to ${peerId}: ${errors.map(e => e.message).join(', ')}`);
}

export function subscribeWithRef(
  stateRef: StateRef<NodeState>,
  topic: string,
  handler: (event: EccoEvent) => void
): () => void {
  const state = getState(stateRef);
  const isFirstSubscription = !state.subscribedTopics.has(topic);

  updateState(stateRef, (s) => {
    const newState = addSubscription(s, topic, handler);
    if (isFirstSubscription) {
      const newTopics = new Map(s.subscribedTopics);
      newTopics.set(topic, new Set([s.id]));
      return { ...newState, subscribedTopics: newTopics };
    }
    return newState;
  });

  addTopicSubscriber(stateRef, topic, state.id);

  if (isFirstSubscription) {
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

          const messageId = rawData.id ?? `${rawData.timestamp}-${rawData.peerId}`;
          if (isMessageDuplicate(currentState, messageId)) {
            return;
          }

          const senderId = rawData.peerId ?? rawData.from ?? 'unknown';
          if (!checkRateLimit(currentState, senderId)) {
            console.warn(`[${currentState.id}] Rate limit exceeded for peer ${senderId}, dropping message`);
            return;
          }

          markMessageSeen(currentState, messageId);
          checkAndRotateDeduplicator(stateRef);

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
    } else if (hasTransportLayer(state)) {
      updateState(stateRef, (s) => {
        if (!s.messageBridge) return s;

        return {
          ...s,
          messageBridge: bridgeSubscribeToTopic(
            s.messageBridge,
            topic,
            (message: Message) => {
              try {
                const latestState = getState(stateRef);

                const messageId = message.id;
                if (isMessageDuplicate(latestState, messageId)) {
                  return;
                }

                const senderId = message.from;
                if (!checkRateLimit(latestState, senderId)) {
                  console.warn(`[${latestState.id}] Rate limit exceeded for peer ${senderId}, dropping message`);
                  return;
                }

                markMessageSeen(latestState, messageId);
                checkAndRotateDeduplicator(stateRef);

                const payload = message.payload as { topic?: string; event?: EccoEvent };

                if (payload?.event && isValidEvent(payload.event)) {
                  const validatedEvent = validateEvent(payload.event);
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
    } else {
      throw new Error('No messaging transport available');
    }
  }

  return () => {
    updateState(stateRef, (s) => removeSubscription(s, topic, handler));
    removeTopicSubscriber(stateRef, topic, state.id);
  };
}

