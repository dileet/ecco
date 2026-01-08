import type { Message, VersionHandshakePayload, ConstitutionMismatchNotice } from '../types';
import type { TransportMessage } from './types';
import type { AuthState, SignedMessage } from '../services/auth';
import type { NetworkConfig } from '../networks';
import { signMessage, verifyMessage } from '../services/auth';
import { z } from 'zod';
import { debug, delay, createMessageDeduplicator, type MessageDeduplicator } from '../utils';
import {
  createHandshakeMessage,
  createHandshakeResponse,
  createIncompatibleNotice,
  parseHandshakePayload,
  parseHandshakeResponse,
  HANDSHAKE_TIMEOUT_MS,
  DISCONNECT_DELAY_MS,
} from '../protocol/handshake';
import { formatVersion } from '../protocol/version';
import { createConstitutionMismatchNotice, computeConstitutionHash } from '../protocol/constitution';

const MAX_QUEUED_MESSAGES_PER_PEER = 100;
const QUEUED_MESSAGE_DEDUP_FALSE_POSITIVE_RATE = 0.01;
const MAX_MESSAGE_SIZE_BYTES = 10 * 1024 * 1024;

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
  networkConfig?: NetworkConfig;
}

export interface PendingHandshake {
  initiated: number;
  timeoutId?: ReturnType<typeof setTimeout>;
}

export interface MessageBridgeState {
  config: MessageBridgeConfig;
  authState?: AuthState;
  topicHandlers: Map<string, Set<(message: Message) => void>>;
  directHandlers: Map<string, Set<(message: Message) => void>>;
  validatedPeers: Set<string>;
  pendingHandshakes: Map<string, PendingHandshake>;
  queuedMessages: Map<string, Message[]>;
  queuedMessageDeduplicators: Map<string, MessageDeduplicator>;
  onPeerValidated?: (peerId: string) => void;
  onPeerRejected?: (peerId: string, reason: string) => void;
  onUpgradeRequired?: (peerId: string, requiredVersion: string, upgradeUrl?: string) => void;
  onConstitutionMismatch?: (peerId: string, expectedHash: string, receivedHash: string) => void;
  onHandshakeTimeout?: (peerId: string) => void;
  sendMessage?: (peerId: string, message: Message) => Promise<void>;
  disconnectPeer?: (peerId: string) => Promise<void>;
}

export interface HandshakeInitiation {
  state: MessageBridgeState;
  message: Message | null;
}

const MessageBridgeConfigSchema = z.object({
  nodeId: z.string().min(1),
  authEnabled: z.boolean(),
  networkConfig: z.object({
    protocol: z.object({
      enforcementLevel: z.string(),
    }),
  }).optional(),
});

export function createMessageBridge(
  config: MessageBridgeConfig,
  authState?: AuthState
): MessageBridgeState {
  const configResult = MessageBridgeConfigSchema.safeParse(config);
  if (!configResult.success) {
    throw new Error(`Invalid MessageBridgeConfig: ${configResult.error.message}`);
  }

  return {
    config,
    authState,
    topicHandlers: new Map(),
    directHandlers: new Map(),
    validatedPeers: new Set(),
    pendingHandshakes: new Map(),
    queuedMessages: new Map(),
    queuedMessageDeduplicators: new Map(),
  };
}

export function setAuthState(
  state: MessageBridgeState,
  authState: AuthState
): MessageBridgeState {
  return { ...state, authState };
}

export function shutdownMessageBridge(
  state: MessageBridgeState
): MessageBridgeState {
  for (const pending of state.pendingHandshakes.values()) {
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
  }

  return {
    ...state,
    topicHandlers: new Map(),
    directHandlers: new Map(),
    validatedPeers: new Set(),
    pendingHandshakes: new Map(),
    queuedMessages: new Map(),
    queuedMessageDeduplicators: new Map(),
    onPeerValidated: undefined,
    onPeerRejected: undefined,
    onUpgradeRequired: undefined,
    onConstitutionMismatch: undefined,
    onHandshakeTimeout: undefined,
    sendMessage: undefined,
    disconnectPeer: undefined,
  };
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
    if (transportMessage.data.byteLength > MAX_MESSAGE_SIZE_BYTES) {
      debug('deserializeMessage', `Message too large: ${transportMessage.data.byteLength} bytes exceeds ${MAX_MESSAGE_SIZE_BYTES}`);
      return { message: null, valid: false, updatedState: state };
    }

    const json = new TextDecoder().decode(transportMessage.data);
    const result = MessageSchema.safeParse(JSON.parse(json));

    if (!result.success) {
      debug('deserializeMessage', `Schema validation failed: ${result.error.message}`);
      return { message: null, valid: false, updatedState: state };
    }

    const parsed = result.data;

    if (state.config.authEnabled && state.authState) {
      if (!parsed.signature) {
        debug('deserializeMessage', 'Auth enabled but message has no signature, rejecting');
        return { message: null, valid: false, updatedState: state };
      }

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
  } catch (error) {
    debug('deserializeMessage', `Deserialization error: ${error instanceof Error ? error.message : String(error)}`);
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

const TopicSchema = z.string().min(1).max(256);

export function subscribeToTopic(
  state: MessageBridgeState,
  topic: string,
  handler: (message: Message) => void
): MessageBridgeState {
  const topicResult = TopicSchema.safeParse(topic);
  if (!topicResult.success) {
    debug('subscribeToTopic', `Invalid topic: ${topic}`);
    return state;
  }

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

  if (message.from.toLowerCase() !== peerId.toLowerCase()) {
    debug('handleIncomingTransportMessage', `Message 'from' field (${message.from}) does not match transport peerId (${peerId}), discarding`);
    return updatedState;
  }

  debug('handleIncomingTransportMessage', `Message type=${message.type}, from=${message.from}, to=${message.to}`);

  const peerHandlers = updatedState.directHandlers.get(peerId);
  debug('handleIncomingTransportMessage', `peerHandlers for ${peerId}: ${peerHandlers?.size ?? 0}`);
  if (peerHandlers && peerHandlers.size > 0) {
    for (const handler of Array.from(peerHandlers)) {
      handler(message);
    }
  }

  const globalHandlers = updatedState.directHandlers.get('*');
  debug('handleIncomingTransportMessage', `globalHandlers (*): ${globalHandlers?.size ?? 0}`);
  if (globalHandlers && globalHandlers.size > 0) {
    for (const handler of Array.from(globalHandlers)) {
      handler(message);
    }
  }

  if (message.to && message.type === 'agent-response') {
    const topic = `peer:${message.to}`;
    const topicHandlers = updatedState.topicHandlers.get(topic);
    debug('handleIncomingTransportMessage', `topicHandlers for ${topic}: ${topicHandlers?.size ?? 0}`);
    debug('handleIncomingTransportMessage', `All topics: ${Array.from(updatedState.topicHandlers.keys()).join(', ')}`);
    if (topicHandlers && topicHandlers.size > 0) {
      for (const handler of Array.from(topicHandlers)) {
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

      if (message.from.toLowerCase() !== peerId.toLowerCase()) {
        debug('handleIncomingBroadcast', `Message 'from' field (${message.from}) does not match transport peerId (${peerId}), discarding`);
        return state;
      }

      let currentState = state;

      if (state.config.authEnabled && state.authState) {
        if (!message.signature) {
          debug('handleIncomingBroadcast', `Auth enabled but broadcast from ${peerId} has no signature, discarding`);
          return state;
        }

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
        for (const handler of Array.from(handlers)) {
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

export function setHandshakeCallbacks(
  state: MessageBridgeState,
  callbacks: {
    onPeerValidated?: (peerId: string) => void;
    onPeerRejected?: (peerId: string, reason: string) => void;
    onUpgradeRequired?: (peerId: string, requiredVersion: string, upgradeUrl?: string) => void;
    onConstitutionMismatch?: (peerId: string, expectedHash: string, receivedHash: string) => void;
    onHandshakeTimeout?: (peerId: string) => void;
    sendMessage?: (peerId: string, message: Message) => Promise<void>;
    disconnectPeer?: (peerId: string) => Promise<void>;
  }
): MessageBridgeState {
  return {
    ...state,
    onPeerValidated: callbacks.onPeerValidated,
    onPeerRejected: callbacks.onPeerRejected,
    onUpgradeRequired: callbacks.onUpgradeRequired,
    onConstitutionMismatch: callbacks.onConstitutionMismatch,
    onHandshakeTimeout: callbacks.onHandshakeTimeout,
    sendMessage: callbacks.sendMessage,
    disconnectPeer: callbacks.disconnectPeer,
  };
}

export function isPeerValidated(state: MessageBridgeState, peerId: string): boolean {
  return state.validatedPeers.has(peerId);
}

export function isHandshakeRequired(state: MessageBridgeState): boolean {
  return state.config.networkConfig?.protocol.enforcementLevel !== 'none';
}

export async function initiateHandshake(
  state: MessageBridgeState,
  peerId: string
): Promise<HandshakeInitiation> {
  const networkConfig = state.config.networkConfig;

  if (!networkConfig) {
    debug('handshake', `Cannot initiate handshake with ${peerId}: networkConfig is required`);
    state.onPeerRejected?.(peerId, 'Network configuration required for handshake');
    return { state, message: null };
  }

  if (networkConfig.protocol.enforcementLevel === 'none') {
    const validatedPeers = new Set(state.validatedPeers);
    validatedPeers.add(peerId);
    return { state: { ...state, validatedPeers }, message: null };
  }

  if (!state.sendMessage) {
    debug('handshake', `Cannot initiate handshake with ${peerId}: sendMessage not configured`);
    state.onPeerRejected?.(peerId, 'Send message handler required for handshake');
    return { state, message: null };
  }

  if (state.validatedPeers.has(peerId) || state.pendingHandshakes.has(peerId)) {
    return { state, message: null };
  }

  const handshakeMessage = await createHandshakeMessage(
    state.config.nodeId,
    peerId,
    networkConfig
  );

  const timeoutId = setTimeout(() => {
    state.onHandshakeTimeout?.(peerId);
  }, HANDSHAKE_TIMEOUT_MS);

  const pendingHandshakes = new Map(state.pendingHandshakes);
  pendingHandshakes.set(peerId, { initiated: Date.now(), timeoutId });

  return { state: { ...state, pendingHandshakes }, message: handshakeMessage };
}

export function handleHandshakeTimeout(
  state: MessageBridgeState,
  peerId: string
): MessageBridgeState {
  if (!state.pendingHandshakes.has(peerId)) {
    return state;
  }

  const pendingHandshakes = new Map(state.pendingHandshakes);
  pendingHandshakes.delete(peerId);

  debug('handshake', `Handshake timeout for peer ${peerId}`);

  const networkConfig = state.config.networkConfig;
  if (!networkConfig) {
    return { ...state, pendingHandshakes };
  }

  if (networkConfig.protocol.enforcementLevel === 'strict') {
    state.onPeerRejected?.(peerId, 'Handshake timeout');
    state.disconnectPeer?.(peerId);
    return { ...state, pendingHandshakes };
  }

  const validatedPeers = new Set(state.validatedPeers);
  validatedPeers.add(peerId);
  state.onPeerValidated?.(peerId);

  return { ...state, pendingHandshakes, validatedPeers };
}

export async function handleVersionHandshake(
  state: MessageBridgeState,
  peerId: string,
  message: Message
): Promise<MessageBridgeState> {
  const networkConfig = state.config.networkConfig;

  if (!networkConfig) {
    debug('handshake', `Cannot handle handshake from ${peerId}: networkConfig is required`);
    state.onPeerRejected?.(peerId, 'Network configuration required for handshake');
    state.disconnectPeer?.(peerId);
    return state;
  }

  if (networkConfig.protocol.enforcementLevel === 'none') {
    const validatedPeers = new Set(state.validatedPeers);
    validatedPeers.add(peerId);
    state.onPeerValidated?.(peerId);
    return { ...state, validatedPeers };
  }

  if (!state.sendMessage) {
    debug('handshake', `Cannot respond to handshake from ${peerId}: sendMessage not configured`);
    state.onPeerRejected?.(peerId, 'Send message handler required for handshake');
    return state;
  }

  const payload = parseHandshakePayload(message.payload);
  if (!payload) {
    debug('handshake', `Invalid handshake payload from ${peerId} - missing required fields (including constitutionHash)`);
    state.onPeerRejected?.(peerId, 'Invalid handshake payload - constitution required');
    state.disconnectPeer?.(peerId);
    return state;
  }

  debug('handshake', `Received handshake from ${peerId}, version ${formatVersion(payload.protocolVersion)}`);

  const response = await createHandshakeResponse(
    state.config.nodeId,
    peerId,
    networkConfig,
    payload.protocolVersion,
    payload.constitutionHash,
    message.id,
    payload.networkId
  );

  await state.sendMessage(peerId, response);

  const responsePayload = parseHandshakeResponse(response.payload);
  if (!responsePayload?.accepted) {
    if (responsePayload?.constitutionMismatch) {
      const localHash = await computeConstitutionHash(networkConfig.constitution);
      const notice = createConstitutionMismatchNotice(
        state.config.nodeId,
        peerId,
        localHash.hash,
        payload.constitutionHash.hash
      );
      await state.sendMessage(peerId, notice);
      state.onConstitutionMismatch?.(peerId, localHash.hash, payload.constitutionHash.hash);
    } else {
      const notice = createIncompatibleNotice(
        state.config.nodeId,
        peerId,
        networkConfig.protocol,
        payload.protocolVersion
      );
      await state.sendMessage(peerId, notice);
    }

    if (state.disconnectPeer) {
      const disconnectPeer = state.disconnectPeer;
      delay(DISCONNECT_DELAY_MS).then(() => disconnectPeer(peerId)).catch(() => {});
    }

    state.onPeerRejected?.(peerId, responsePayload?.reason ?? 'Handshake rejected');
    return state;
  }

  const validatedPeers = new Set(state.validatedPeers);
  validatedPeers.add(peerId);
  state.onPeerValidated?.(peerId);

  return { ...state, validatedPeers };
}

export async function handleVersionHandshakeResponse(
  state: MessageBridgeState,
  peerId: string,
  message: Message
): Promise<MessageBridgeState> {
  const pending = state.pendingHandshakes.get(peerId);
  if (!pending) {
    debug('handshake', `Received unexpected handshake response from ${peerId}`);
    return state;
  }

  if (pending.timeoutId) {
    clearTimeout(pending.timeoutId);
  }

  const pendingHandshakes = new Map(state.pendingHandshakes);
  pendingHandshakes.delete(peerId);

  const response = parseHandshakeResponse(message.payload);
  if (!response) {
    debug('handshake', `Invalid handshake response from ${peerId}`);
    return { ...state, pendingHandshakes };
  }

  debug('handshake', `Handshake response from ${peerId}: accepted=${response.accepted}`);

  if (!response.accepted) {
    if (response.constitutionMismatch) {
      state.onPeerRejected?.(peerId, response.reason ?? 'Constitution mismatch');
    } else {
      state.onUpgradeRequired?.(
        peerId,
        formatVersion(response.minProtocolVersion),
        response.upgradeUrl
      );
      state.onPeerRejected?.(peerId, response.reason ?? 'Version incompatible');
    }
    return { ...state, pendingHandshakes };
  }

  const validatedPeers = new Set(state.validatedPeers);
  validatedPeers.add(peerId);
  state.onPeerValidated?.(peerId);

  const queuedMessages = new Map(state.queuedMessages);
  const queued = queuedMessages.get(peerId) ?? [];
  queuedMessages.delete(peerId);
  const queuedMessageDeduplicators = new Map(state.queuedMessageDeduplicators);
  queuedMessageDeduplicators.delete(peerId);

  let currentAuthState = state.authState;

  for (const queuedMessage of queued) {
    if (state.config.authEnabled && currentAuthState) {
      if (!queuedMessage.signature) {
        debug('handleVersionHandshakeResponse', `Queued message ${queuedMessage.id} has no signature, discarding`);
        continue;
      }

      const { valid, state: newAuthState } = await verifyMessage(
        currentAuthState,
        queuedMessage as SignedMessage
      );

      if (!valid) {
        debug('handleVersionHandshakeResponse', `Queued message ${queuedMessage.id} failed re-verification, discarding`);
        continue;
      }

      currentAuthState = newAuthState;
    }

    const peerHandlers = state.directHandlers.get(peerId);
    if (peerHandlers) {
      for (const handler of Array.from(peerHandlers)) {
        handler(queuedMessage);
      }
    }
    const globalHandlers = state.directHandlers.get('*');
    if (globalHandlers) {
      for (const handler of Array.from(globalHandlers)) {
        handler(queuedMessage);
      }
    }
  }

  return {
    ...state,
    pendingHandshakes,
    validatedPeers,
    queuedMessages,
    queuedMessageDeduplicators,
    authState: currentAuthState,
  };
}

export function handleVersionIncompatibleNotice(
  state: MessageBridgeState,
  peerId: string,
  message: Message
): MessageBridgeState {
  const payload = message.payload as VersionHandshakePayload | null;
  if (payload) {
    console.warn(`[ecco] Version incompatible with peer ${peerId}. ${(message.payload as { message?: string })?.message ?? ''}`);
    const notice = message.payload as { requiredMinVersion?: { major: number; minor: number; patch: number }; upgradeUrl?: string };
    if (notice.requiredMinVersion) {
      state.onUpgradeRequired?.(
        peerId,
        formatVersion(notice.requiredMinVersion),
        notice.upgradeUrl
      );
    }
  }
  return state;
}

export function handleConstitutionMismatchNotice(
  state: MessageBridgeState,
  peerId: string,
  message: Message
): MessageBridgeState {
  const payload = message.payload as ConstitutionMismatchNotice | null;
  if (payload) {
    console.warn(`[ecco] Constitution mismatch with peer ${peerId}. ${payload.message}`);
    state.onConstitutionMismatch?.(peerId, payload.expectedHash, payload.receivedHash);
  }
  return state;
}

export function queueMessageForPeer(
  state: MessageBridgeState,
  peerId: string,
  message: Message
): MessageBridgeState {
  const queuedMessages = new Map(state.queuedMessages);
  const queued = queuedMessages.get(peerId) ?? [];
  const queuedMessageDeduplicators = new Map(state.queuedMessageDeduplicators);
  const deduplicator =
    queuedMessageDeduplicators.get(peerId) ??
    createMessageDeduplicator(
      MAX_QUEUED_MESSAGES_PER_PEER,
      QUEUED_MESSAGE_DEDUP_FALSE_POSITIVE_RATE
    );
  if (deduplicator.isDuplicate(message.id)) {
    return state;
  }
  if (queued.length >= MAX_QUEUED_MESSAGES_PER_PEER) {
    debug('queueMessageForPeer', `Queue limit reached for peer ${peerId}, dropping message`);
    return state;
  }
  deduplicator.markSeen(message.id);
  if (deduplicator.shouldRotate()) {
    deduplicator.rotate();
  }
  queued.push(message);
  queuedMessages.set(peerId, queued);
  queuedMessageDeduplicators.set(peerId, deduplicator);
  return { ...state, queuedMessages, queuedMessageDeduplicators };
}

export function markPeerValidated(
  state: MessageBridgeState,
  peerId: string
): MessageBridgeState {
  const validatedPeers = new Set(state.validatedPeers);
  validatedPeers.add(peerId);
  return { ...state, validatedPeers };
}

export function removePeerValidation(
  state: MessageBridgeState,
  peerId: string
): MessageBridgeState {
  const validatedPeers = new Set(state.validatedPeers);
  validatedPeers.delete(peerId);
  const pendingHandshakes = new Map(state.pendingHandshakes);
  const pending = pendingHandshakes.get(peerId);
  if (pending?.timeoutId) {
    clearTimeout(pending.timeoutId);
  }
  pendingHandshakes.delete(peerId);
  const queuedMessages = new Map(state.queuedMessages);
  queuedMessages.delete(peerId);
  const queuedMessageDeduplicators = new Map(state.queuedMessageDeduplicators);
  queuedMessageDeduplicators.delete(peerId);
  return { ...state, validatedPeers, pendingHandshakes, queuedMessages, queuedMessageDeduplicators };
}
