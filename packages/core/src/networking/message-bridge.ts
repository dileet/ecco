import type { Message, VersionHandshakePayload, ConstitutionMismatchNotice } from '../types';
import type { TransportMessage } from './transport-types';
import type { AuthState, SignedMessage } from '../auth/authenticator';
import type { NetworkConfig } from '../networks';
import { signMessage, verifyMessage } from '../auth/authenticator';
import { z } from 'zod';
import { debug, delay, createMessageDeduplicator, type MessageDeduplicator } from '../utils';
import {
  createHandshakeMessage,
  createHandshakeResponse,
  createIncompatibleNotice,
  parseHandshakePayload,
  parseHandshakeResponse,
  DISCONNECT_DELAY_MS,
} from '../protocol/handshake';
import { formatVersion } from '../protocol/version';
import { createConstitutionMismatchNotice, computeConstitutionHash } from '../protocol/constitution';
import { MESSAGE_BRIDGE } from './transport-constants';

function dispatchToHandlers(
  state: MessageBridgeState,
  message: Message,
  peerId: string,
  includeTopic?: string
): void {
  const peerHandlers = state.directHandlers.get(peerId);
  if (peerHandlers) {
    for (const handler of peerHandlers) handler(message);
  }

  const globalHandlers = state.directHandlers.get('*');
  if (globalHandlers) {
    for (const handler of globalHandlers) handler(message);
  }

  if (includeTopic) {
    const topicHandlers = state.topicHandlers.get(includeTopic);
    if (topicHandlers) {
      for (const handler of topicHandlers) handler(message);
    }
  }
}

async function verifyAuthIfEnabled(
  state: MessageBridgeState,
  message: Message
): Promise<{ valid: boolean; authState?: AuthState }> {
  if (!state.config.authEnabled || !state.authState) {
    return { valid: true };
  }
  if (!message.signature) {
    return { valid: false };
  }
  const { valid, state: newAuthState } = await verifyMessage(state.authState, message as SignedMessage);
  return { valid, authState: newAuthState };
}

async function signIfEnabled(
  state: MessageBridgeState,
  message: Message
): Promise<Message | SignedMessage> {
  if (state.config.authEnabled && state.authState) {
    return signMessage(state.authState, message);
  }
  return message;
}

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
  sendMessage?: (peerId: string, message: Message) => Promise<void>;
  disconnectPeer?: (peerId: string) => Promise<void>;
}

export interface HandshakeInitiation {
  message: Message | null;
  pendingEntry: { peerId: string; entry: PendingHandshake } | null;
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
    sendMessage: undefined,
    disconnectPeer: undefined,
  };
}

export async function serializeMessage(
  state: MessageBridgeState,
  message: Message
): Promise<TransportMessage> {
  const signed = await signIfEnabled(state, message);
  const data = new TextEncoder().encode(JSON.stringify(signed));
  return { id: message.id, from: message.from, to: message.to, data, timestamp: message.timestamp };
}

export async function deserializeMessage(
  state: MessageBridgeState,
  transportMessage: TransportMessage
): Promise<{ message: Message | null; valid: boolean; updatedState: MessageBridgeState }> {
  try {
    if (transportMessage.data.byteLength > MESSAGE_BRIDGE.MAX_MESSAGE_SIZE_BYTES) {
      debug('deserialize', 'Message too large');
      return { message: null, valid: false, updatedState: state };
    }

    const json = new TextDecoder().decode(transportMessage.data);
    const result = MessageSchema.safeParse(JSON.parse(json));

    if (!result.success) {
      debug('deserialize', `Schema parse failed: ${result.error.message}`);
      return { message: null, valid: false, updatedState: state };
    }

    const parsed = result.data as Message;
    const { valid, authState } = await verifyAuthIfEnabled(state, parsed);

    if (!valid) {
      debug('deserialize', `Auth verification failed for message from ${parsed.from}`);
      return { message: null, valid: false, updatedState: state };
    }

    return {
      message: parsed,
      valid: true,
      updatedState: authState ? { ...state, authState } : state,
    };
  } catch (err) {
    debug('deserialize', `Exception: ${err}`);
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

const TopicSchema = z.string().min(1).max(256).regex(/^[a-zA-Z0-9:_-]+$/, 'Topic contains invalid characters');

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
  const { message, valid, updatedState } = await deserializeMessage(state, transportMessage);

  if (!valid || !message) {
    return updatedState;
  }

  if (message.from.toLowerCase() !== peerId.toLowerCase()) {
    debug('handleIncomingTransportMessage', `Message 'from' mismatch: ${message.from} vs ${peerId}`);
    return updatedState;
  }

  const topic = message.to && message.type === 'agent-response' ? `peer:${message.to}` : undefined;
  dispatchToHandlers(updatedState, message, peerId, topic);

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
  const signed = await signIfEnabled(state, message);
  const data = new TextEncoder().encode(JSON.stringify({ topic, message: signed }));
  return { id: message.id, from: message.from, to: 'broadcast', data, timestamp: message.timestamp };
}

export async function handleIncomingBroadcast(
  state: MessageBridgeState,
  peerId: string,
  transportMessage: TransportMessage
): Promise<MessageBridgeState> {
  try {
    const json = new TextDecoder().decode(transportMessage.data);
    const result = TopicMessageSchema.safeParse(JSON.parse(json));

    if (!result.success) {
      return handleIncomingTransportMessage(state, peerId, transportMessage);
    }

    const { topic, message } = result.data;

    if (message.from.toLowerCase() !== peerId.toLowerCase()) {
      debug('handleIncomingBroadcast', `Message 'from' mismatch: ${message.from} vs ${peerId}`);
      return state;
    }

    const { valid, authState } = await verifyAuthIfEnabled(state, message as Message);
    if (!valid) {
      return state;
    }

    const handlers = state.topicHandlers.get(topic);
    if (handlers) {
      for (const handler of handlers) handler(message as Message);
    }

    return authState ? { ...state, authState } : state;
  } catch {
    return handleIncomingTransportMessage(state, peerId, transportMessage);
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
    sendMessage: callbacks.sendMessage,
    disconnectPeer: callbacks.disconnectPeer,
  };
}

export function isPeerValidated(state: MessageBridgeState, peerId: string): boolean {
  return state.validatedPeers.has(peerId);
}

export function isPeerPendingHandshake(state: MessageBridgeState, peerId: string): boolean {
  return state.pendingHandshakes.has(peerId);
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
    debug('handshake', `Cannot initiate with ${peerId}: no networkConfig`);
    state.onPeerRejected?.(peerId, 'Network configuration required for handshake');
    return { message: null, pendingEntry: null };
  }

  if (!state.sendMessage) {
    debug('handshake', `Cannot initiate with ${peerId}: no sendMessage`);
    state.onPeerRejected?.(peerId, 'Send message handler required for handshake');
    return { message: null, pendingEntry: null };
  }

  if (state.validatedPeers.has(peerId)) {
    return { message: null, pendingEntry: null };
  }

  if (state.pendingHandshakes.has(peerId)) {
    return { message: null, pendingEntry: null };
  }

  const handshakeMessage = await createHandshakeMessage(
    state.config.nodeId,
    peerId,
    networkConfig
  );

  return {
    message: handshakeMessage,
    pendingEntry: { peerId, entry: { initiated: Date.now() } },
  };
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
    debug('handshake', `No networkConfig for ${peerId}`);
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
    debug('handshake', `No sendMessage for ${peerId}`);
    state.onPeerRejected?.(peerId, 'Send message handler required for handshake');
    return state;
  }

  const payload = parseHandshakePayload(message.payload);
  if (!payload) {
    debug('handshake', `Invalid payload from ${peerId}`);
    state.onPeerRejected?.(peerId, 'Invalid handshake payload - constitution required');
    state.disconnectPeer?.(peerId);
    return state;
  }

  const response = await createHandshakeResponse(
    state.config.nodeId,
    peerId,
    networkConfig,
    payload.protocolVersion,
    payload.constitutionHash,
    message.id,
    payload.networkId
  );

  const responsePayload = parseHandshakeResponse(response.payload);
  const accepted = responsePayload?.accepted ?? false;

  if (!accepted) {
    debug('handshake', `Rejecting ${peerId}: ${responsePayload?.reason}`);
    try {
      await state.sendMessage(peerId, response);
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
    } catch (err) {
      console.warn('[ecco] Failed to send handshake rejection:', err instanceof Error ? err.message : String(err));
    }

    if (state.disconnectPeer) {
      const disconnectPeer = state.disconnectPeer;
      delay(DISCONNECT_DELAY_MS).then(() => disconnectPeer(peerId)).catch((err) => {
        console.warn(`[ecco] Failed to disconnect peer ${peerId}:`, err instanceof Error ? err.message : String(err));
      });
    }

    state.onPeerRejected?.(peerId, responsePayload?.reason ?? 'Handshake rejected');
    return state;
  }

  debug('handshake', `Validating ${peerId}`);
  const validatedPeers = new Set(state.validatedPeers);
  validatedPeers.add(peerId);
  state.onPeerValidated?.(peerId);
  debug('handshake', `Validated ${peerId}`);

  debug('handshake', `Sending response to ${peerId}`);
  state.sendMessage(peerId, response).catch((err) => {
    debug('handshake', `Response send failed to ${peerId}: ${err}`);
  });

  return { ...state, validatedPeers };
}

export async function handleVersionHandshakeResponse(
  state: MessageBridgeState,
  peerId: string,
  message: Message
): Promise<MessageBridgeState> {
  debug('handshake', `Received response from ${peerId}`);
  const pending = state.pendingHandshakes.get(peerId);
  if (!pending) {
    debug('handshake', `No pending handshake for ${peerId}, ignoring response`);
    return state;
  }

  const pendingHandshakes = new Map(state.pendingHandshakes);
  pendingHandshakes.delete(peerId);

  const response = parseHandshakeResponse(message.payload);
  if (!response) {
    return { ...state, pendingHandshakes };
  }

  if (!response.accepted) {
    if (response.constitutionMismatch) {
      state.onPeerRejected?.(peerId, response.reason ?? 'Constitution mismatch');
    } else {
      state.onUpgradeRequired?.(peerId, formatVersion(response.minProtocolVersion), response.upgradeUrl);
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
    const tempState = { ...state, authState: currentAuthState };
    const { valid, authState: newAuthState } = await verifyAuthIfEnabled(tempState, queuedMessage);
    if (!valid) continue;
    if (newAuthState) currentAuthState = newAuthState;
    dispatchToHandlers(state, queuedMessage, peerId);
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
      MESSAGE_BRIDGE.MAX_QUEUED_MESSAGES_PER_PEER,
      MESSAGE_BRIDGE.QUEUED_MESSAGE_DEDUP_FALSE_POSITIVE_RATE
    );
  if (deduplicator.isDuplicate(message.id)) {
    return state;
  }
  if (queued.length >= MESSAGE_BRIDGE.MAX_QUEUED_MESSAGES_PER_PEER) {
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
  pendingHandshakes.delete(peerId);
  const queuedMessages = new Map(state.queuedMessages);
  queuedMessages.delete(peerId);
  const queuedMessageDeduplicators = new Map(state.queuedMessageDeduplicators);
  queuedMessageDeduplicators.delete(peerId);
  return { ...state, validatedPeers, pendingHandshakes, queuedMessages, queuedMessageDeduplicators };
}
