import type {
  TransportAdapter,
  TransportType,
  TransportState,
  TransportPeer,
  TransportMessage,
  TransportDiscoveryEvent,
  TransportConnectionEvent,
} from '../types';
import { z } from 'zod';

const TransportMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  data: z.array(z.number()).transform((arr) => new Uint8Array(arr)),
  timestamp: z.number(),
});

const RTCSessionDescriptionSchema = z.object({
  type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
  sdp: z.string().optional(),
});

const RTCIceCandidateSchema = z.object({
  candidate: z.string().optional(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
});

const SignalingMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('peer-list'), peers: z.array(z.string()) }),
  z.object({ type: z.literal('peer-joined'), peerId: z.string() }),
  z.object({ type: z.literal('peer-left'), peerId: z.string() }),
  z.object({ type: z.literal('offer'), from: z.string(), offer: RTCSessionDescriptionSchema }),
  z.object({ type: z.literal('answer'), from: z.string(), answer: RTCSessionDescriptionSchema }),
  z.object({ type: z.literal('ice-candidate'), from: z.string(), candidate: RTCIceCandidateSchema }),
]);

interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface RTCSessionDescriptionInit {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

interface RTCDataChannelEvent {
  channel: RTCDataChannel;
}

interface RTCPeerConnectionIceEvent {
  candidate: RTCIceCandidate | null;
}

interface RTCIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  toJSON(): RTCIceCandidateInit;
}

interface RTCDataChannel {
  label: string;
  readyState: 'connecting' | 'open' | 'closing' | 'closed';
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: (() => void) | null;
  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void;
  close(): void;
}

interface RTCPeerConnection {
  connectionState: 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null;
  onconnectionstatechange: (() => void) | null;
  createDataChannel(label: string): RTCDataChannel;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  close(): void;
}

interface RTCConfiguration {
  iceServers?: RTCIceServer[];
}

declare const RTCPeerConnection: {
  new(config?: RTCConfiguration): RTCPeerConnection;
};

declare const WebSocket: {
  new(url: string): WebSocket;
  readonly OPEN: number;
};

interface WebSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface WebRTCAdapterConfig {
  signalingServer?: string;
  iceServers?: RTCIceServer[];
  dataChannelLabel?: string;
}

export interface WebRTCAdapterState {
  config: WebRTCAdapterConfig;
  state: TransportState;
  localPeerId: string;
  connections: Map<string, RTCPeerConnection>;
  dataChannels: Map<string, RTCDataChannel>;
  discoveredPeers: Map<string, TransportPeer>;
  connectedPeers: Map<string, TransportPeer>;
  pendingOffers: Map<string, RTCSessionDescriptionInit>;
  discoveryHandlers: Set<(event: TransportDiscoveryEvent) => void>;
  connectionHandlers: Set<(event: TransportConnectionEvent) => void>;
  messageHandlers: Set<(peerId: string, message: TransportMessage) => void>;
  signalingSocket?: WebSocket;
  cleanups: Array<() => void>;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const DEFAULT_DATA_CHANNEL = 'ecco-data';

export function createWebRTCAdapter(
  localPeerId: string,
  config: Partial<WebRTCAdapterConfig> = {}
): WebRTCAdapterState {
  return {
    config: {
      signalingServer: config.signalingServer,
      iceServers: config.iceServers ?? DEFAULT_ICE_SERVERS,
      dataChannelLabel: config.dataChannelLabel ?? DEFAULT_DATA_CHANNEL,
    },
    state: 'disconnected',
    localPeerId,
    connections: new Map(),
    dataChannels: new Map(),
    discoveredPeers: new Map(),
    connectedPeers: new Map(),
    pendingOffers: new Map(),
    discoveryHandlers: new Set(),
    connectionHandlers: new Set(),
    messageHandlers: new Set(),
    cleanups: [],
  };
}

export async function initialize(state: WebRTCAdapterState): Promise<WebRTCAdapterState> {
  if (!state.config.signalingServer) {
    return { ...state, state: 'connected' };
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(state.config.signalingServer!);
    const cleanups: Array<() => void> = [];

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'register',
        peerId: state.localPeerId,
      }));

      resolve({
        ...state,
        state: 'connected',
        signalingSocket: ws,
        cleanups,
      });
    };

    ws.onmessage = (event) => {
      const result = SignalingMessageSchema.safeParse(JSON.parse(event.data));
      if (result.success) {
        handleSignalingMessage(state, result.data);
      }
    };

    ws.onerror = () => {
      reject(new Error('WebRTC signaling connection failed'));
    };

    ws.onclose = () => {
      state.state = 'disconnected';
    };

    cleanups.push(() => ws.close());
  });
}

export async function shutdown(state: WebRTCAdapterState): Promise<WebRTCAdapterState> {
  for (const cleanup of state.cleanups) {
    cleanup();
  }

  for (const channel of state.dataChannels.values()) {
    channel.close();
  }

  for (const connection of state.connections.values()) {
    connection.close();
  }

  state.signalingSocket?.close();

  return {
    ...state,
    state: 'disconnected',
    connections: new Map(),
    dataChannels: new Map(),
    connectedPeers: new Map(),
    discoveredPeers: new Map(),
    cleanups: [],
    signalingSocket: undefined,
  };
}

async function handleSignalingMessage(
  state: WebRTCAdapterState,
  message: z.infer<typeof SignalingMessageSchema>
): Promise<void> {
  switch (message.type) {
    case 'peer-list':
      handlePeerList(state, message.peers);
      break;
    case 'peer-joined':
      handlePeerJoined(state, message.peerId);
      break;
    case 'peer-left':
      handlePeerLeft(state, message.peerId);
      break;
    case 'offer':
      await handleOffer(state, message.from, message.offer);
      break;
    case 'answer':
      await handleAnswer(state, message.from, message.answer);
      break;
    case 'ice-candidate':
      await handleIceCandidate(state, message.from, message.candidate);
      break;
  }
}


function handlePeerList(state: WebRTCAdapterState, peers: string[]): void {
  for (const peerId of peers) {
    if (peerId === state.localPeerId) continue;

    const peer: TransportPeer = {
      id: peerId,
      transport: 'webrtc' as TransportType,
      addresses: [`webrtc://${peerId}`],
      lastSeen: Date.now(),
    };

    state.discoveredPeers.set(peerId, peer);

    for (const handler of state.discoveryHandlers) {
      handler({ type: 'discovered', peer });
    }
  }
}

function handlePeerJoined(state: WebRTCAdapterState, peerId: string): void {
  if (peerId === state.localPeerId) return;

  const peer: TransportPeer = {
    id: peerId,
    transport: 'webrtc' as TransportType,
    addresses: [`webrtc://${peerId}`],
    lastSeen: Date.now(),
  };

  state.discoveredPeers.set(peerId, peer);

  for (const handler of state.discoveryHandlers) {
    handler({ type: 'discovered', peer });
  }
}

function handlePeerLeft(state: WebRTCAdapterState, peerId: string): void {
  const peer = state.discoveredPeers.get(peerId);
  if (!peer) return;

  state.discoveredPeers.delete(peerId);
  state.connectedPeers.delete(peerId);
  state.connections.get(peerId)?.close();
  state.connections.delete(peerId);
  state.dataChannels.delete(peerId);

  for (const handler of state.discoveryHandlers) {
    handler({ type: 'lost', peer });
  }
}

async function handleOffer(
  state: WebRTCAdapterState,
  fromPeerId: string,
  offer: RTCSessionDescriptionInit
): Promise<void> {
  const connection = createPeerConnection(state, fromPeerId);

  await connection.setRemoteDescription(offer);
  const answer = await connection.createAnswer();
  await connection.setLocalDescription(answer);

  sendSignalingMessage(state, {
    type: 'answer',
    to: fromPeerId,
    answer,
  });
}

async function handleAnswer(
  state: WebRTCAdapterState,
  fromPeerId: string,
  answer: RTCSessionDescriptionInit
): Promise<void> {
  const connection = state.connections.get(fromPeerId);
  if (!connection) return;

  await connection.setRemoteDescription(answer);
}

async function handleIceCandidate(
  state: WebRTCAdapterState,
  fromPeerId: string,
  candidate: RTCIceCandidateInit
): Promise<void> {
  const connection = state.connections.get(fromPeerId);
  if (!connection) return;

  await connection.addIceCandidate(candidate);
}

function createPeerConnection(
  state: WebRTCAdapterState,
  peerId: string
): RTCPeerConnection {
  const connection = new RTCPeerConnection({
    iceServers: state.config.iceServers,
  });

  state.connections.set(peerId, connection);

  connection.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignalingMessage(state, {
        type: 'ice-candidate',
        to: peerId,
        candidate: event.candidate.toJSON(),
      });
    }
  };

  connection.ondatachannel = (event) => {
    setupDataChannel(state, peerId, event.channel);
  };

  connection.onconnectionstatechange = () => {
    if (connection.connectionState === 'connected') {
      const peer = state.discoveredPeers.get(peerId);
      if (peer) {
        state.connectedPeers.set(peerId, peer);
        for (const handler of state.connectionHandlers) {
          handler({ type: 'connected', peerId, transport: 'webrtc' as TransportType });
        }
      }
    } else if (
      connection.connectionState === 'disconnected' ||
      connection.connectionState === 'failed'
    ) {
      state.connectedPeers.delete(peerId);
      for (const handler of state.connectionHandlers) {
        handler({ type: 'disconnected', peerId, transport: 'webrtc' as TransportType });
      }
    }
  };

  return connection;
}

function setupDataChannel(
  state: WebRTCAdapterState,
  peerId: string,
  channel: RTCDataChannel
): void {
  state.dataChannels.set(peerId, channel);

  channel.onmessage = (event) => {
    const message = decodeMessage(event.data);
    if (message) {
      for (const handler of state.messageHandlers) {
        handler(peerId, message);
      }
    }
  };

  channel.onclose = () => {
    state.dataChannels.delete(peerId);
  };
}

function sendSignalingMessage(
  state: WebRTCAdapterState,
  message: Record<string, unknown>
): void {
  if (!state.signalingSocket || state.signalingSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  state.signalingSocket.send(JSON.stringify({
    ...message,
    from: state.localPeerId,
  }));
}

export async function startDiscovery(state: WebRTCAdapterState): Promise<void> {
  if (state.signalingSocket) {
    sendSignalingMessage(state, { type: 'request-peers' });
  }
}

export async function stopDiscovery(_state: WebRTCAdapterState): Promise<void> {
}

export async function connect(
  state: WebRTCAdapterState,
  peerId: string
): Promise<void> {
  if (state.connections.has(peerId)) return;

  const connection = createPeerConnection(state, peerId);
  const channel = connection.createDataChannel(state.config.dataChannelLabel!);
  setupDataChannel(state, peerId, channel);

  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);

  sendSignalingMessage(state, {
    type: 'offer',
    to: peerId,
    offer,
  });
}

export async function disconnect(
  state: WebRTCAdapterState,
  peerId: string
): Promise<void> {
  state.dataChannels.get(peerId)?.close();
  state.dataChannels.delete(peerId);

  state.connections.get(peerId)?.close();
  state.connections.delete(peerId);

  state.connectedPeers.delete(peerId);

  for (const handler of state.connectionHandlers) {
    handler({ type: 'disconnected', peerId, transport: 'webrtc' as TransportType });
  }
}

export async function send(
  state: WebRTCAdapterState,
  peerId: string,
  message: TransportMessage
): Promise<void> {
  const channel = state.dataChannels.get(peerId);
  if (!channel || channel.readyState !== 'open') {
    throw new Error(`No open data channel to peer ${peerId}`);
  }

  const data = encodeMessage(message);
  channel.send(data);
}

export async function broadcast(
  state: WebRTCAdapterState,
  message: TransportMessage
): Promise<void> {
  const sendPromises = Array.from(state.dataChannels.entries())
    .filter(([_, channel]) => channel.readyState === 'open')
    .map(([peerId]) => send(state, peerId, message).catch(() => {}));

  await Promise.all(sendPromises);
}

export function onDiscovery(
  state: WebRTCAdapterState,
  handler: (event: TransportDiscoveryEvent) => void
): () => void {
  state.discoveryHandlers.add(handler);
  return () => state.discoveryHandlers.delete(handler);
}

export function onConnection(
  state: WebRTCAdapterState,
  handler: (event: TransportConnectionEvent) => void
): () => void {
  state.connectionHandlers.add(handler);
  return () => state.connectionHandlers.delete(handler);
}

export function onMessage(
  state: WebRTCAdapterState,
  handler: (peerId: string, message: TransportMessage) => void
): () => void {
  state.messageHandlers.add(handler);
  return () => state.messageHandlers.delete(handler);
}

export function getConnectedPeers(state: WebRTCAdapterState): TransportPeer[] {
  return Array.from(state.connectedPeers.values());
}

export function getDiscoveredPeers(state: WebRTCAdapterState): TransportPeer[] {
  return Array.from(state.discoveredPeers.values());
}

function encodeMessage(message: TransportMessage): string {
  return JSON.stringify({
    id: message.id,
    from: message.from,
    to: message.to,
    data: Array.from(message.data),
    timestamp: message.timestamp,
  });
}

function decodeMessage(data: string): TransportMessage | null {
  try {
    const result = TransportMessageSchema.safeParse(JSON.parse(data));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function toAdapter(state: WebRTCAdapterState): TransportAdapter {
  return {
    type: 'webrtc' as TransportType,
    get state() { return state.state; },
    initialize: () => initialize(state).then(() => undefined),
    shutdown: () => shutdown(state).then(() => undefined),
    startDiscovery: () => startDiscovery(state),
    stopDiscovery: () => stopDiscovery(state),
    connect: (peerId: string) => connect(state, peerId),
    disconnect: (peerId: string) => disconnect(state, peerId),
    send: (peerId: string, message: TransportMessage) => send(state, peerId, message),
    broadcast: (message: TransportMessage) => broadcast(state, message),
    getConnectedPeers: () => getConnectedPeers(state),
    getDiscoveredPeers: () => getDiscoveredPeers(state),
    onDiscovery: (handler) => onDiscovery(state, handler),
    onConnection: (handler) => onConnection(state, handler),
    onMessage: (handler) => onMessage(state, handler),
  };
}

