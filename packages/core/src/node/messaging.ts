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
  isPeerValidated,
  isHandshakeRequired,
} from '../transport/message-bridge';
import { isHandshakeMessage } from '../protocol/handshake';
import { debug } from '../utils';

const pubsubAbortControllers = new Map<string, AbortController>();

function getPubsubKey(nodeId: string, topic: string): string {
  return `${nodeId}:${topic}`;
}

const PubSubMessageSchema = z.object({
  topic: z.string(),
  data: z.instanceof(Uint8Array),
});

const PeerIdSchema = z.preprocess(
  (val) => (val && typeof val === 'object' && 'toString' in val ? String(val) : val),
  z.string()
);

const PubSubEventDetailSchema = z.object({
  topic: z.string(),
  data: z.instanceof(Uint8Array),
  from: PeerIdSchema.optional(),
});

const MessageDetailSchema = z.union([
  z.object({ msg: PubSubMessageSchema }).transform(({ msg }) => msg),
  PubSubMessageSchema,
]);

interface ExtractedPubSubData {
  topic: string;
  data: Uint8Array;
  transportPeerId: string | null;
}

function extractMessageData(detail: unknown): ExtractedPubSubData | null {
  const eventResult = PubSubEventDetailSchema.safeParse(detail);
  if (eventResult.success) {
    return {
      topic: eventResult.data.topic,
      data: eventResult.data.data,
      transportPeerId: eventResult.data.from ?? null,
    };
  }

  const result = MessageDetailSchema.safeParse(detail);
  if (result.success) {
    return {
      topic: result.data.topic,
      data: result.data.data,
      transportPeerId: null,
    };
  }
  return null;
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

export function removeAllTopicSubscriptionsForPeer(stateRef: StateRef<NodeState>, peerId: string): void {
  updateState(stateRef, (s) => {
    const newTopicSubscribers = new Map<string, Set<string>>();
    for (const [topic, subscribers] of s.floodProtection.topicSubscribers) {
      if (subscribers.has(peerId)) {
        const newSubscribers = new Set(subscribers);
        newSubscribers.delete(peerId);
        if (newSubscribers.size > 0) {
          newTopicSubscribers.set(topic, newSubscribers);
        }
      } else {
        newTopicSubscribers.set(topic, subscribers);
      }
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
  let validatedEvent = validateEvent(event);

  if (state.messageAuth && validatedEvent.type === 'message' && validatedEvent.payload) {
    const payload = validatedEvent.payload as { id?: string; from?: string; type?: string };
    if (payload.id && payload.from && payload.type) {
      const signedPayload = await signMessage(state.messageAuth, payload as Message);
      validatedEvent = { ...validatedEvent, payload: signedPayload };
    }
  }

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
    const localPeerIds = new Set<string>([state.id.toLowerCase()]);
    if (state.libp2pPeerId) {
      localPeerIds.add(state.libp2pPeerId.toLowerCase());
    }
    const nodePeerId = state.node?.peerId?.toString();
    if (nodePeerId) {
      localPeerIds.add(nodePeerId.toLowerCase());
    }

    const remoteSubscribers = new Set<string>();
    for (const subscriber of subscribers) {
      const normalized = subscriber.toLowerCase();
      if (!localPeerIds.has(normalized)) {
        remoteSubscribers.add(normalized);
      }
    }

    if (remoteSubscribers.size > 0) {
      for (const adapter of state.transport!.adapters.values()) {
        if (adapter.state === 'connected') {
          const connectedPeers = adapter.getConnectedPeers();
          for (const peer of connectedPeers) {
            if (remoteSubscribers.has(peer.id.toLowerCase())) {
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
  if (state.shuttingDown) {
    return;
  }

  const nodePeerId = state.node?.peerId?.toString();
  const normalizedPeerId = peerId.toLowerCase();
  const isSelf = normalizedPeerId === state.libp2pPeerId?.toLowerCase() ||
                 normalizedPeerId === state.id.toLowerCase() ||
                 (nodePeerId && normalizedPeerId === nodePeerId.toLowerCase());

  if (isSelf) {
    debug('publishDirect', `Skipping send to self (${peerId})`);
    return;
  }

  if (!hasTransportLayer(state) || !state.transport) {
    throw new Error('No transport available for direct messaging');
  }

  if (state.messageBridge && !isHandshakeMessage(message)) {
    if (isHandshakeRequired(state.messageBridge) && !isPeerValidated(state.messageBridge, peerId)) {
      debug('publishDirect', `Peer ${peerId} not validated, message blocked`);
      throw new Error(`Cannot send message to unvalidated peer ${peerId}. Handshake required.`);
    }
  }

  debug('publishDirect', `Sending to ${peerId}, type=${message.type}`);
  let messageToSend = message;
  if (state.messageAuth) {
    messageToSend = await signMessage(state.messageAuth, message);
  }

  const transportMessage = await serializeMessage(
    state.messageBridge!,
    messageToSend
  );

  const errors: Error[] = [];

  debug('publishDirect', `Adapters: ${Array.from(state.transport.adapters.keys()).join(', ')}`);
  for (const adapter of state.transport.adapters.values()) {
    debug('publishDirect', `Adapter ${adapter.type} state=${adapter.state}`);
    if (adapter.state === 'connected') {
      try {
        debug('publishDirect', `Sending via ${adapter.type} adapter`);
        await adapter.send(peerId, transportMessage);
        debug('publishDirect', 'Send successful');
        return;
      } catch (err) {
        debug('publishDirect', `Send failed: ${err}`);
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  if (errors.length === 0) {
    return;
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
  debug('subscribeWithRef', `Subscribing to topic=${topic}, isFirstSubscription=${isFirstSubscription}, hasPubsub=${!!state.node?.services.pubsub}, hasTransport=${hasTransportLayer(state)}`);

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
      debug('subscribeWithRef', `Setting up pubsub subscription for ${topic}`);
      const pubsub = state.node.services.pubsub;
      pubsub.subscribe(topic);

      const pubsubKey = getPubsubKey(state.id, topic);
      if (pubsubAbortControllers.has(pubsubKey)) {
        debug('subscribeWithRef', `Listener already exists for ${topic}, skipping`);
      } else {
        const abortController = new AbortController();
        pubsubAbortControllers.set(pubsubKey, abortController);

        pubsub.addEventListener('message', async (evt) => {
        const messageData = extractMessageData(evt.detail);
        if (!messageData || messageData.topic !== topic) {
          return;
        }

        try {
          const rawData = JSON.parse(new TextDecoder().decode(messageData.data));
          const currentState = getState(stateRef);

          const transportPeerId = messageData.transportPeerId;
          if (currentState.messageBridge && isHandshakeRequired(currentState.messageBridge)) {
            if (!transportPeerId) {
              console.warn(`[${currentState.id}] Pubsub message missing transport peer ID, dropping message`);
              return;
            }
            if (!isPeerValidated(currentState.messageBridge, transportPeerId)) {
              console.warn(`[${currentState.id}] Pubsub message from unvalidated peer ${transportPeerId}, dropping message`);
              return;
            }
          }

          const claimedSender = rawData.peerId ?? rawData.from ?? 'unknown';

          if (transportPeerId && claimedSender !== 'unknown' && claimedSender.toLowerCase() !== transportPeerId.toLowerCase()) {
            console.warn(`[${currentState.id}] Claimed sender (${claimedSender}) does not match transport peer ID (${transportPeerId}), dropping message`);
            return;
          }

          const rateLimitId = transportPeerId ?? claimedSender;

          const messageId = rawData.id ?? `${rawData.timestamp}-${rawData.peerId}`;
          if (isMessageDuplicate(currentState, messageId)) {
            return;
          }

          if (!checkRateLimit(currentState, rateLimitId)) {
            console.warn(`[${currentState.id}] Rate limit exceeded for peer ${rateLimitId}, dropping message`);
            return;
          }

          markMessageSeen(currentState, messageId);
          checkAndRotateDeduplicator(stateRef);

          if (currentState.messageAuth) {
            if (!rawData.signature) {
              console.warn('Auth enabled but received unsigned pubsub message, ignoring');
              return;
            }
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
      }, { signal: abortController.signal });
      }
    }

    if (hasTransportLayer(state)) {
      debug('subscribeWithRef', `Setting up message bridge subscription for ${topic}`);
      updateState(stateRef, (s) => {
        if (!s.messageBridge) return s;

        return {
          ...s,
          messageBridge: bridgeSubscribeToTopic(
            s.messageBridge,
            topic,
            (message: Message) => {
              debug('subscribeWithRef bridge handler', `Received message on topic ${topic}, type=${message.type}`);
              try {
                const latestState = getState(stateRef);

                const messageId = message.id;
                if (isMessageDuplicate(latestState, messageId)) {
                  debug('subscribeWithRef bridge handler', `Duplicate message ${messageId}, skipping`);
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
                debug('subscribeWithRef bridge handler', `Payload has event=${!!payload?.event}`);

                const handlers = latestState.subscriptions[topic];
                debug('subscribeWithRef bridge handler', `Found ${handlers?.length ?? 0} handlers for topic ${topic}`);

                if (handlers && handlers.length > 0) {
                  if (payload?.event && isValidEvent(payload.event)) {
                    const validatedEvent = validateEvent(payload.event);
                    handlers.forEach((h) => h(validatedEvent));
                  } else {
                    const wrappedEvent: EccoEvent = {
                      type: 'message',
                      from: message.from,
                      to: message.to,
                      payload: message,
                      timestamp: message.timestamp,
                    };
                    handlers.forEach((h) => h(wrappedEvent));
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
    }

    if (!state.node?.services.pubsub && !hasTransportLayer(state)) {
      throw new Error('No messaging transport available');
    }
  }

  return () => {
    updateState(stateRef, (s) => removeSubscription(s, topic, handler));
    removeTopicSubscriber(stateRef, topic, state.id);

    const currentState = getState(stateRef);
    const remainingHandlers = currentState.subscriptions[topic];
    const isLastSubscription = !remainingHandlers || remainingHandlers.length === 0;

    if (isLastSubscription) {
      const pubsubKey = getPubsubKey(currentState.id, topic);
      const abortController = pubsubAbortControllers.get(pubsubKey);
      if (abortController) {
        abortController.abort();
        pubsubAbortControllers.delete(pubsubKey);
      }

      if (currentState.node?.services.pubsub) {
        currentState.node.services.pubsub.unsubscribe(topic);
      }

      updateState(stateRef, (s) => {
        const newTopics = new Map(s.subscribedTopics);
        newTopics.delete(topic);
        return { ...s, subscribedTopics: newTopics };
      });
    }
  };
}
