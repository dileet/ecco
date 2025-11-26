import type { Libp2p, PeerId } from '@libp2p/interface';
import type { GossipSub } from '@libp2p/gossipsub';
import { z } from 'zod';
import type {
  TransportAdapter,
  TransportState,
  TransportPeer,
  TransportMessage,
  TransportDiscoveryEvent,
  TransportConnectionEvent,
} from '../types';

interface EccoLibp2pServices extends Record<string, unknown> {
  pubsub?: GossipSub;
}

type Libp2pNode = Libp2p<EccoLibp2pServices>;

export interface Libp2pAdapterConfig {
  node: Libp2pNode;
  topic?: string;
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

export function initialize(state: Libp2pAdapterState): Libp2pAdapterState {
  const { node, topic } = state.config;
  const cleanups: Array<() => void> = [];

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

  node.addEventListener('peer:discovery', handlePeerDiscovery as EventListener);
  node.addEventListener('peer:connect', handlePeerConnect as EventListener);
  node.addEventListener('peer:disconnect', handlePeerDisconnect as EventListener);

  cleanups.push(() => {
    node.removeEventListener('peer:discovery', handlePeerDiscovery as EventListener);
    node.removeEventListener('peer:connect', handlePeerConnect as EventListener);
    node.removeEventListener('peer:disconnect', handlePeerDisconnect as EventListener);
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
  const connections = node.getConnections().filter(c => c.remotePeer.toString() === peerId);

  for (const conn of connections) {
    await conn.close();
  }
}

export async function send(
  state: Libp2pAdapterState,
  _peerId: string,
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
