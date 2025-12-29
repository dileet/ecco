import type { Libp2p, PeerId, Stream } from '@libp2p/interface';
import type { GossipSub } from '@libp2p/gossipsub';
import { peerIdFromString } from '@libp2p/peer-id';
import { z } from 'zod';
import type {
  TransportAdapter,
  TransportState,
  TransportPeer,
  TransportMessage,
  TransportDiscoveryEvent,
  TransportConnectionEvent,
} from '../types';
import type { ProtocolVersion } from '../../types';
import type { NetworkConfig } from '../../networks';
import { SDK_PROTOCOL_VERSION } from '../../networks';
const { multiaddr } = await import('@multiformats/multiaddr');

interface EccoLibp2pServices extends Record<string, unknown> {
  pubsub?: GossipSub;
}

type Libp2pNode = Libp2p<EccoLibp2pServices>;

export interface Libp2pAdapterConfig {
  node: Libp2pNode;
  topic?: string;
  networkConfig?: NetworkConfig;
}

export function buildDirectProtocol(version: ProtocolVersion = SDK_PROTOCOL_VERSION): string {
  return `/ecco/direct/${version.major}.${version.minor}.${version.patch}`;
}

export interface Libp2pAdapterState {
  config: Libp2pAdapterConfig;
  state: TransportState;
  discoveredPeers: Map<string, TransportPeer>;
  connectedPeers: Map<string, TransportPeer>;
  discoveryHandlers: Set<(event: TransportDiscoveryEvent) => void>;
  connectionHandlers: Set<(event: TransportConnectionEvent) => void>;
  messageHandlers: Set<(peerId: string, message: TransportMessage) => void>;
  cleanups: Array<() => void>;
}

const ECCO_TRANSPORT_TOPIC = 'ecco/transport/v1';

export function createLibp2pAdapter(
  config: Libp2pAdapterConfig
): Libp2pAdapterState {
  return {
    config: {
      ...config,
      topic: config.topic ?? ECCO_TRANSPORT_TOPIC,
    },
    state: 'disconnected',
    discoveredPeers: new Map(),
    connectedPeers: new Map(),
    discoveryHandlers: new Set(),
    connectionHandlers: new Set(),
    messageHandlers: new Set(),
    cleanups: [],
  };
}

const pubSubMessageSchema = z.object({
  topic: z.string(),
  data: z.instanceof(Uint8Array),
});

const messageDetailSchema = z.union([
  z.object({ msg: pubSubMessageSchema }).transform(({ msg }) => msg),
  pubSubMessageSchema,
]);

function extractMessageData(detail: unknown): z.infer<typeof pubSubMessageSchema> | null {
  const result = messageDetailSchema.safeParse(detail);
  return result.success ? result.data : null;
}

interface IncomingStreamData {
  stream: Stream;
  connection: { remotePeer: { toString(): string } };
}

function isIncomingStreamData(data: unknown): data is IncomingStreamData {
  if (typeof data !== 'object' || data === null) return false;
  return 'stream' in data && 'connection' in data;
}

function isAsyncIterable(data: unknown): data is Stream {
  if (typeof data !== 'object' || data === null) return false;
  return Symbol.asyncIterator in data;
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return new Uint8Array(bytes);
}

function decodeVarint(data: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  
  while (offset + bytesRead < data.length) {
    const byte = data[offset + bytesRead];
    value |= (byte & 0x7f) << shift;
    bytesRead++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  
  return { value, bytesRead };
}

function lengthPrefixEncode(data: Uint8Array): Uint8Array {
  const prefix = encodeVarint(data.length);
  const result = new Uint8Array(prefix.length + data.length);
  result.set(prefix, 0);
  result.set(data, prefix.length);
  return result;
}

function lengthPrefixDecode(data: Uint8Array): Uint8Array[] {
  const messages: Uint8Array[] = [];
  let offset = 0;
  
  while (offset < data.length) {
    const { value: length, bytesRead } = decodeVarint(data, offset);
    offset += bytesRead;
    if (offset + length <= data.length) {
      messages.push(data.slice(offset, offset + length));
      offset += length;
    } else {
      break;
    }
  }
  
  return messages;
}

function getProtocolVersion(state: Libp2pAdapterState): string {
  const version = state.config.networkConfig?.protocol.currentVersion ?? SDK_PROTOCOL_VERSION;
  return buildDirectProtocol(version);
}

export function initialize(state: Libp2pAdapterState): Libp2pAdapterState {
  const { node, topic } = state.config;
  const cleanups: Array<() => void> = [];
  const protocol = getProtocolVersion(state);

  function handlePeerDiscovery(evt: CustomEvent<{ id: PeerId; multiaddrs: unknown[] }>): void {
    const { id: peerId } = evt.detail;
    const peerIdStr = peerId.toString();

    const peer: TransportPeer = {
      id: peerIdStr,
      transport: 'libp2p',
      addresses: node.getMultiaddrs().map(String),
      lastSeen: Date.now(),
    };

    state.discoveredPeers.set(peerIdStr, peer);

    for (const handler of state.discoveryHandlers) {
      handler({ type: 'discovered', peer });
    }
  }

  function handlePeerConnect(evt: CustomEvent<PeerId>): void {
    const peerIdStr = evt.detail.toString();

    const peer: TransportPeer = state.discoveredPeers.get(peerIdStr) ?? {
      id: peerIdStr,
      transport: 'libp2p',
      addresses: [],
      lastSeen: Date.now(),
    };

    state.connectedPeers.set(peerIdStr, peer);

    for (const handler of state.connectionHandlers) {
      handler({ type: 'connected', peerId: peerIdStr, transport: 'libp2p' });
    }
  }

  function handlePeerDisconnect(evt: CustomEvent<PeerId>): void {
    const peerIdStr = evt.detail.toString();
    state.connectedPeers.delete(peerIdStr);

    for (const handler of state.connectionHandlers) {
      handler({ type: 'disconnected', peerId: peerIdStr, transport: 'libp2p' });
    }
  }

  const existingPeers = node.getPeers();
  for (const peerId of existingPeers) {
    const peerIdStr = peerId.toString();
    const peer: TransportPeer = {
      id: peerIdStr,
      transport: 'libp2p',
      addresses: [],
      lastSeen: Date.now(),
    };
    state.connectedPeers.set(peerIdStr, peer);
    state.discoveredPeers.set(peerIdStr, peer);
  }

  node.addEventListener('peer:discovery', handlePeerDiscovery as EventListener);
  node.addEventListener('peer:connect', handlePeerConnect as EventListener);
  node.addEventListener('peer:disconnect', handlePeerDisconnect as EventListener);

  cleanups.push(() => {
    node.removeEventListener('peer:discovery', handlePeerDiscovery as EventListener);
    node.removeEventListener('peer:connect', handlePeerConnect as EventListener);
    node.removeEventListener('peer:disconnect', handlePeerDisconnect as EventListener);
  });

  node.handle(protocol, async (incomingData) => {
    try {
      const stream = isIncomingStreamData(incomingData) 
        ? incomingData.stream 
        : isAsyncIterable(incomingData) 
          ? incomingData 
          : null;
      
      const remotePeerIdFromConnection = isIncomingStreamData(incomingData)
        ? incomingData.connection.remotePeer.toString()
        : null;
      
      if (!stream) {
        return;
      }
      
      const chunks: Uint8Array[] = [];
      
      for await (const chunk of stream) {
        const data = chunk instanceof Uint8Array ? chunk : chunk.subarray();
        chunks.push(data);
      }
      
      if (chunks.length === 0) {
        return;
      }
      
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      
      const messages = lengthPrefixDecode(combined);
      
      for (const data of messages) {
        const decoded = decodeMessage(data);
        if (decoded) {
          const remotePeerId = remotePeerIdFromConnection ?? decoded.from;
          for (const handler of state.messageHandlers) {
            handler(remotePeerId, decoded);
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && !error.message.includes('aborted')) {
        console.warn('Failed to handle direct stream message:', error);
      }
    }
  });

  cleanups.push(() => {
    node.unhandle(protocol).catch(() => {});
  });

  const pubsub = node.services.pubsub;
  if (pubsub) {
    pubsub.subscribe(topic!);

    function handlePubsubMessage(evt: CustomEvent<unknown>): void {
      const messageData = extractMessageData(evt.detail);
      if (!messageData || messageData.topic !== topic) {
        return;
      }

      try {
        const decoded = decodeMessage(messageData.data);
        if (decoded) {
          for (const handler of state.messageHandlers) {
            handler(decoded.from, decoded);
          }
        }
      } catch (error) {
        console.warn('Failed to decode transport message:', error);
      }
    }

    pubsub.addEventListener('message', handlePubsubMessage as EventListener);

    cleanups.push(() => {
      pubsub.removeEventListener('message', handlePubsubMessage as EventListener);
      pubsub.unsubscribe(topic!);
    });
  }

  return {
    ...state,
    state: 'connected',
    cleanups,
  };
}

export function shutdown(state: Libp2pAdapterState): Libp2pAdapterState {
  for (const cleanup of state.cleanups) {
    cleanup();
  }

  return {
    ...state,
    state: 'disconnected',
    cleanups: [],
    connectedPeers: new Map(),
    discoveredPeers: new Map(),
  };
}

export function startDiscovery(_state: Libp2pAdapterState): void {
}

export function stopDiscovery(_state: Libp2pAdapterState): void {
}

export async function connect(
  state: Libp2pAdapterState,
  peerId: string
): Promise<void> {
  const { node } = state.config;
  const peer = state.discoveredPeers.get(peerId);

  if (peer?.addresses.length) {
    const { multiaddr } = await import('@multiformats/multiaddr');
    const addr = multiaddr(peer.addresses[0]);
    await node.dial(addr);
  }
}

export async function disconnect(
  state: Libp2pAdapterState,
  peerId: string
): Promise<void> {
  const { node } = state.config;
  const connections = node.getConnections().filter(c => c.remotePeer.toString().toLowerCase() === peerId.toLowerCase());

  for (const conn of connections) {
    await conn.close();
  }
}

export async function send(
  state: Libp2pAdapterState,
  peerId: string,
  message: TransportMessage
): Promise<void> {
  const { node } = state.config;

  const selfPeerId = node.peerId.toString();
  if (peerId.toLowerCase() === selfPeerId.toLowerCase()) {
    return;
  }

  const targetPeerId = peerIdFromString(peerId);
  const protocol = getProtocolVersion(state);

  const ensureConnection = async (): Promise<void> => {
    let connections = node.getConnections(targetPeerId)
    if (connections.length === 0) {
      const peer = state.discoveredPeers.get(peerId);
      try {
        if (peer?.addresses.length) {
          const addr = multiaddr(peer.addresses[0]);
          await node.dial(addr);
        } else {
          await node.dial(targetPeerId);
        }
      } catch (err) {
        if (err instanceof Error && err.message.toLowerCase().includes('dial self')) {
          return;
        }
        throw err;
      }
      connections = node.getConnections(targetPeerId)
    }

    if (connections.length === 0) {
      throw new Error(`No connection to peer ${peerId}`);
    }
  }

  const tryOpenStream = async (forceReconnect = false): Promise<Stream> => {
    if (forceReconnect) {
      const existingConnections = node.getConnections(targetPeerId);
      for (const conn of existingConnections) {
        try {
          await conn.close();
        } catch {}
      }
      await ensureConnection();
    } else {
      await ensureConnection();
    }

    const stream = await node.dialProtocol(targetPeerId, protocol);

    if (!stream) {
      throw new Error('dialProtocol returned null stream');
    }

    if (stream.writeStatus !== 'writable') {
      stream.abort(new Error(`Stream not writable: ${stream.writeStatus}`));
      throw new Error(`Stream opened in non-writable state: ${stream.writeStatus}`);
    }

    return stream;
  }

  let stream: Stream;
  try {
    stream = await tryOpenStream(false);
  } catch (err) {
    if (err instanceof Error && err.message.includes('non-writable')) {
      stream = await tryOpenStream(true);
    } else {
      throw err;
    }
  }

  const data = encodeMessage(message);
  const framedData = lengthPrefixEncode(data);

  try {
    stream.send(framedData);
    await stream.close();
  } catch (err) {
    stream.abort(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

export async function broadcast(
  state: Libp2pAdapterState,
  message: TransportMessage
): Promise<void> {
  const { node, topic } = state.config;
  const pubsub = node.services.pubsub;

  if (!pubsub) {
    throw new Error('Pubsub not available on this node');
  }

  const data = encodeMessage(message);
  await pubsub.publish(topic!, data);
}

export function onDiscovery(
  state: Libp2pAdapterState,
  handler: (event: TransportDiscoveryEvent) => void
): () => void {
  state.discoveryHandlers.add(handler);
  return () => state.discoveryHandlers.delete(handler);
}

export function onConnection(
  state: Libp2pAdapterState,
  handler: (event: TransportConnectionEvent) => void
): () => void {
  state.connectionHandlers.add(handler);
  return () => state.connectionHandlers.delete(handler);
}

export function onMessage(
  state: Libp2pAdapterState,
  handler: (peerId: string, message: TransportMessage) => void
): () => void {
  state.messageHandlers.add(handler);
  return () => state.messageHandlers.delete(handler);
}

export function getConnectedPeers(state: Libp2pAdapterState): TransportPeer[] {
  return Array.from(state.connectedPeers.values());
}

export function getDiscoveredPeers(state: Libp2pAdapterState): TransportPeer[] {
  return Array.from(state.discoveredPeers.values());
}

function encodeMessage(message: TransportMessage): Uint8Array {
  const json = JSON.stringify({
    id: message.id,
    from: message.from,
    to: message.to,
    data: Array.from(message.data),
    timestamp: message.timestamp,
  });
  return new TextEncoder().encode(json);
}

function decodeMessage(data: Uint8Array): TransportMessage | null {
  try {
    const json = new TextDecoder().decode(data);
    const parsed = JSON.parse(json);
    return {
      id: parsed.id,
      from: parsed.from,
      to: parsed.to,
      data: new Uint8Array(parsed.data),
      timestamp: parsed.timestamp,
    };
  } catch {
    return null;
  }
}

export function toAdapter(state: Libp2pAdapterState): TransportAdapter {
  return {
    type: 'libp2p',
    get state() { return state.state; },
    initialize: () => Promise.resolve(initialize(state)).then(() => undefined),
    shutdown: () => Promise.resolve(shutdown(state)).then(() => undefined),
    startDiscovery: () => Promise.resolve(startDiscovery(state)),
    stopDiscovery: () => Promise.resolve(stopDiscovery(state)),
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
