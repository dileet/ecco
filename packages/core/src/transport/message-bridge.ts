import type { Message } from '../types';
import type { TransportMessage } from './types';
import type { AuthState, SignedMessage } from '../services/auth';
import { signMessage, verifyMessage } from '../services/auth';
import { z } from 'zod';
import { debug } from '../utils';

const MessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  type: z.string(),
  payload: z.unknown(),
  timestamp: z.number(),
  signature: z.string().optional(),
  publicKey: z.string().optional(),
});

const TopicMessageSchema = z.object({
  topic: z.string(),
  message: MessageSchema,
});

export interface MessageBridgeConfig {
  nodeId: string;
  authEnabled: boolean;
}

export interface MessageBridgeState {
  config: MessageBridgeConfig;
  authState?: AuthState;
  topicHandlers: Map<string, Set<(message: Message) => void>>;
  directHandlers: Map<string, Set<(message: Message) => void>>;
}

export function createMessageBridge(
  config: MessageBridgeConfig,
  authState?: AuthState
): MessageBridgeState {
  return {
    config,
    authState,
    topicHandlers: new Map(),
    directHandlers: new Map(),
  };
}

export function setAuthState(
  state: MessageBridgeState,
  authState: AuthState
): MessageBridgeState {
  return { ...state, authState };
}

export async function serializeMessage(
  state: MessageBridgeState,
  message: Message
): Promise<TransportMessage> {
  let messageToSerialize: Message | SignedMessage = message;

  if (state.config.authEnabled && state.authState) {
    messageToSerialize = await signMessage(state.authState, message);
  }

  const json = JSON.stringify(messageToSerialize);
  const data = new TextEncoder().encode(json);

  return {
    id: message.id,
    from: message.from,
    to: message.to,
    data,
    timestamp: message.timestamp,
  };
}

export async function deserializeMessage(
  state: MessageBridgeState,
  transportMessage: TransportMessage
): Promise<{ message: Message | null; valid: boolean; updatedState: MessageBridgeState }> {
  try {
    const json = new TextDecoder().decode(transportMessage.data);
    const result = MessageSchema.safeParse(JSON.parse(json));

    if (!result.success) {
      return { message: null, valid: false, updatedState: state };
    }

    const parsed = result.data;

    if (state.config.authEnabled && state.authState && parsed.signature) {
      const { valid, state: newAuthState } = await verifyMessage(
        state.authState,
        parsed as SignedMessage
      );

      if (!valid) {
        return { message: null, valid: false, updatedState: state };
      }

      return {
        message: parsed as Message,
        valid: true,
        updatedState: { ...state, authState: newAuthState },
      };
    }

    return {
      message: parsed as Message,
      valid: true,
      updatedState: state,
    };
  } catch {
    return { message: null, valid: false, updatedState: state };
  }
}

export function createMessage(
  state: MessageBridgeState,
  to: string,
  type: Message['type'],
  payload: unknown
): Message {
  return {
    id: crypto.randomUUID(),
    from: state.config.nodeId,
    to,
    type,
    payload,
    timestamp: Date.now(),
  };
}

export function subscribeToTopic(
  state: MessageBridgeState,
  topic: string,
  handler: (message: Message) => void
): MessageBridgeState {
  const handlers = state.topicHandlers.get(topic) ?? new Set();
  handlers.add(handler);
  const topicHandlers = new Map(state.topicHandlers);
  topicHandlers.set(topic, handlers);
  return { ...state, topicHandlers };
}

export function unsubscribeFromTopic(
  state: MessageBridgeState,
  topic: string,
  handler: (message: Message) => void
): MessageBridgeState {
  const handlers = state.topicHandlers.get(topic);
  if (handlers) {
    handlers.delete(handler);
    if (handlers.size === 0) {
      const topicHandlers = new Map(state.topicHandlers);
      topicHandlers.delete(topic);
      return { ...state, topicHandlers };
    }
  }
  return state;
}

export function subscribeToDirectMessages(
  state: MessageBridgeState,
  peerId: string,
  handler: (message: Message) => void
): MessageBridgeState {
  const handlers = state.directHandlers.get(peerId) ?? new Set();
  handlers.add(handler);
  const directHandlers = new Map(state.directHandlers);
  directHandlers.set(peerId, handlers);
  return { ...state, directHandlers };
}

export function subscribeToAllDirectMessages(
  state: MessageBridgeState,
  handler: (message: Message) => void
): MessageBridgeState {
  return subscribeToDirectMessages(state, '*', handler);
}

export async function handleIncomingTransportMessage(
  state: MessageBridgeState,
  peerId: string,
  transportMessage: TransportMessage
): Promise<MessageBridgeState> {
  debug('handleIncomingTransportMessage', `Received from ${peerId}`);
  const { message, valid, updatedState } = await deserializeMessage(state, transportMessage);

  if (!valid || !message) {
    debug('handleIncomingTransportMessage', `Invalid message, valid=${valid}`);
    return updatedState;
  }

  debug('handleIncomingTransportMessage', `Message type=${message.type}, from=${message.from}, to=${message.to}`);

  const peerHandlers = updatedState.directHandlers.get(peerId);
  debug('handleIncomingTransportMessage', `peerHandlers for ${peerId}: ${peerHandlers?.size ?? 0}`);
  if (peerHandlers && peerHandlers.size > 0) {
    for (const handler of peerHandlers) {
      handler(message);
    }
  }

  const globalHandlers = updatedState.directHandlers.get('*');
  debug('handleIncomingTransportMessage', `globalHandlers (*): ${globalHandlers?.size ?? 0}`);
  if (globalHandlers && globalHandlers.size > 0) {
    for (const handler of globalHandlers) {
      handler(message);
    }
  }

  if (message.to && message.type === 'agent-response') {
    const topic = `peer:${message.to}`;
    const topicHandlers = updatedState.topicHandlers.get(topic);
    debug('handleIncomingTransportMessage', `topicHandlers for ${topic}: ${topicHandlers?.size ?? 0}`);
    debug('handleIncomingTransportMessage', `All topics: ${Array.from(updatedState.topicHandlers.keys()).join(', ')}`);
    if (topicHandlers && topicHandlers.size > 0) {
      for (const handler of topicHandlers) {
        handler(message);
      }
    }
  }

  return updatedState;
}

export interface TopicMessage {
  topic: string;
  message: Message;
}

export async function serializeTopicMessage(
  state: MessageBridgeState,
  topic: string,
  message: Message
): Promise<TransportMessage> {
  let messageToSerialize: Message | SignedMessage = message;

  if (state.config.authEnabled && state.authState) {
    messageToSerialize = await signMessage(state.authState, message);
  }

  const topicMessage: TopicMessage = {
    topic,
    message: messageToSerialize,
  };

  const json = JSON.stringify(topicMessage);
  const data = new TextEncoder().encode(json);

  return {
    id: message.id,
    from: message.from,
    to: 'broadcast',
    data,
    timestamp: message.timestamp,
  };
}

export async function handleIncomingBroadcast(
  state: MessageBridgeState,
  peerId: string,
  transportMessage: TransportMessage
): Promise<MessageBridgeState> {
  debug('handleIncomingBroadcast', `Received from ${peerId}`);
  try {
    const json = new TextDecoder().decode(transportMessage.data);
    const result = TopicMessageSchema.safeParse(JSON.parse(json));

    if (result.success) {
      const topicMessage = result.data;
      const message = topicMessage.message;
      debug('handleIncomingBroadcast', `Parsed as topic message, topic=${topicMessage.topic}`);
      let currentState = state;

      if (state.config.authEnabled && state.authState && message.signature) {
        const { valid, state: newAuthState } = await verifyMessage(
          state.authState,
          message as SignedMessage
        );

        if (!valid) {
          console.warn(`Invalid broadcast signature from ${peerId}, discarding`);
          return state;
        }

        currentState = { ...currentState, authState: newAuthState };
      }

      const handlers = currentState.topicHandlers.get(topicMessage.topic);
      debug('handleIncomingBroadcast', `Found ${handlers?.size ?? 0} handlers for topic ${topicMessage.topic}`);
      if (handlers && handlers.size > 0) {
        for (const handler of handlers) {
          handler(message as Message);
        }
      }

      return currentState;
    }

    debug('handleIncomingBroadcast', 'Not a topic message, falling back to handleIncomingTransportMessage');
    return await handleIncomingTransportMessage(state, peerId, transportMessage);
  } catch {
    debug('handleIncomingBroadcast', 'Parse error, falling back to handleIncomingTransportMessage');
    return await handleIncomingTransportMessage(state, peerId, transportMessage);
  }
}

export function getSubscribedTopics(state: MessageBridgeState): string[] {
  return Array.from(state.topicHandlers.keys());
}

