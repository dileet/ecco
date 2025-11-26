import type { Capability, CapabilityQuery, PeerInfo } from './types';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { delay, withTimeout } from './utils';

const RegistryNodeSchema = z.object({
  nodeId: z.string(),
  addresses: z.array(z.string()),
  capabilities: z.array(z.object({
    type: z.string(),
    name: z.string(),
    version: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })),
  lastSeen: z.number(),
  reputation: z.number(),
});

const NodesResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ nodes: z.array(RegistryNodeSchema) }),
});

const NodeReputationSchema = z.object({
  success: z.literal(true),
  data: z.object({ reputation: z.number() }),
});

const WsMessageSchema = z.object({
  type: z.string(),
  id: z.string(),
  payload: z.unknown(),
});

export interface ClientConfig {
  url: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  timeout?: number;
}

export interface ClientState {
  config: ClientConfig;
  ws: WebSocket | null;
  connected: boolean;
  nodeId?: string;
  messageHandlers: Map<string, (response: unknown) => void>;
  reconnectTimer?: NodeJS.Timeout;
  pingTimer?: NodeJS.Timeout;
  mode: 'ws' | 'http';
}

function handleMessage(state: ClientState, data: string): ClientState {
  const result = WsMessageSchema.safeParse(JSON.parse(data));
  if (!result.success) {
    console.error('Error handling registry message: Failed to parse');
    return state;
  }

  const message = result.data;

  if (message.type === 'welcome') {
    console.log('Registry welcome:', message.payload);
    return state;
  }

  if (message.type === 'response' || message.type === 'error') {
    const handler = state.messageHandlers.get(message.id);
    if (handler) {
      handler(message.payload);
      const newHandlers = new Map(state.messageHandlers);
      newHandlers.delete(message.id);
      return { ...state, messageHandlers: newHandlers };
    }
    return state;
  }

  if (message.type === 'pong') {
    return state;
  }

  console.log('Unhandled registry message:', message);
  return state;
}

function startPingInterval(state: ClientState): ClientState {
  const pingTimer = setInterval(() => {
    if (!state.connected || !state.nodeId) return;

    if (state.mode === 'http') {
      fetch(`${state.config.url}/api/ping`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId: state.nodeId, timestamp: Date.now() }),
      }).catch(() => {});
      return;
    }

    if (state.ws) {
      state.ws.send(JSON.stringify({
        id: nanoid(),
        type: 'ping',
        payload: { nodeId: state.nodeId, timestamp: Date.now() },
        timestamp: Date.now(),
      }));
    }
  }, 30000);

  return { ...state, pingTimer };
}

function stopPingInterval(state: ClientState): ClientState {
  if (state.pingTimer) {
    clearInterval(state.pingTimer);
    return { ...state, pingTimer: undefined };
  }
  return state;
}

function scheduleReconnect(state: ClientState): void {
  if (state.reconnectTimer) return;

  const reconnectInterval = state.config.reconnectInterval || 5000;
  console.log(`Reconnecting to registry in ${reconnectInterval}ms...`);

  delay(reconnectInterval).then(async () => {
    try {
      await connect(state.config);
    } catch (error) {
      console.error('Reconnection failed:', error);
      scheduleReconnect({ ...state, reconnectTimer: undefined });
    }
  });
}

function sendWsMessage(state: ClientState, id: string, type: string, payload: unknown): void {
  if (!state.connected || !state.ws) {
    throw new Error('Not connected to registry');
  }
  state.ws.send(JSON.stringify({ id, type, payload, timestamp: Date.now() }));
}

export async function connect(config: ClientConfig): Promise<ClientState> {
  const isHttp = config.url.startsWith('http://') || config.url.startsWith('https://');
  const baseState: ClientState = {
    config: { reconnect: true, reconnectInterval: 5000, timeout: 10000, ...config },
    ws: null,
    connected: false,
    messageHandlers: new Map(),
    mode: isHttp ? 'http' : 'ws',
  };

  if (isHttp) {
    const res = await fetch(`${config.url}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const newState = startPingInterval({ ...baseState, connected: true });
    console.log(`Connected to registry (HTTP): ${config.url}`);
    return newState;
  }

  const connectionPromise = new Promise<ClientState>((resolve, reject) => {
    const ws = new WebSocket(config.url);
    let newState: ClientState = { ...baseState, ws };

    ws.onopen = () => {
      newState = startPingInterval({ ...newState, connected: true });
      console.log(`Connected to registry: ${config.url}`);
      resolve(newState);
    };

    ws.onmessage = (event) => {
      newState = handleMessage(newState, event.data);
    };

    ws.onerror = (error) => {
      console.error('Registry WebSocket error:', error);
      reject(error);
    };

    ws.onclose = () => {
      newState = stopPingInterval({ ...newState, connected: false });
      console.log('Disconnected from registry');
      if (newState.config.reconnect) {
        scheduleReconnect(newState);
      }
    };
  });

  return withTimeout(connectionPromise, baseState.config.timeout!, 'Connection timeout');
}

export async function disconnect(state: ClientState): Promise<ClientState> {
  let newState: ClientState = { ...state, config: { ...state.config, reconnect: false } };

  if (newState.reconnectTimer) {
    clearTimeout(newState.reconnectTimer);
    newState = { ...newState, reconnectTimer: undefined };
  }

  newState = stopPingInterval(newState);

  if (newState.mode === 'ws' && newState.ws) {
    newState.ws.close();
    return { ...newState, ws: null, connected: false };
  }

  return { ...newState, connected: false };
}

export async function register(
  state: ClientState,
  nodeId: string,
  capabilities: Capability[],
  addresses: string[]
): Promise<ClientState> {
  if (state.mode === 'http') {
    const res = await fetch(`${state.config.url}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeId,
        capabilities: capabilities.map((c) => ({
          type: c.type,
          name: c.name,
          version: c.version,
          ...(c.metadata && { metadata: c.metadata }),
        })),
        addresses,
      }),
    });
    if (!res.ok) throw new Error(`Register failed: HTTP ${res.status}`);
    return { ...state, nodeId };
  }

  sendWsMessage(state, nanoid(), 'register', { nodeId, capabilities, addresses });
  return { ...state, nodeId };
}

export async function unregister(state: ClientState): Promise<ClientState> {
  if (!state.nodeId) return state;

  if (state.mode === 'http') {
    await fetch(`${state.config.url}/api/unregister`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: state.nodeId }),
    });
    return { ...state, nodeId: undefined };
  }

  sendWsMessage(state, nanoid(), 'unregister', { nodeId: state.nodeId });
  return { ...state, nodeId: undefined };
}

export async function query(state: ClientState, capabilityQuery: CapabilityQuery): Promise<PeerInfo[]> {
  const toNode = (n: z.infer<typeof RegistryNodeSchema>): PeerInfo => ({
    id: n.nodeId,
    addresses: n.addresses,
    capabilities: n.capabilities,
    lastSeen: n.lastSeen,
    reputation: n.reputation,
  });

  if (state.mode === 'http') {
    const params = new URLSearchParams();
    const first = capabilityQuery.requiredCapabilities[0];
    if (first?.type) params.set('type', first.type);
    if (first?.name) params.set('name', first.name);

    const res = await fetch(`${state.config.url}/api/capabilities/search?${params.toString()}`);
    if (!res.ok) return [];

    try {
      const { data } = NodesResponseSchema.parse(await res.json());
      return data.nodes.map(toNode).sort((a, b) => (b.reputation || 0) - (a.reputation || 0));
    } catch {
      return [];
    }
  }

  const id = nanoid();
  const queryPromise = new Promise<z.infer<typeof NodesResponseSchema>>((resolve, reject) => {
    state.messageHandlers.set(id, (res) => {
      try {
        resolve(NodesResponseSchema.parse(res));
      } catch {
        reject(new Error('Invalid response'));
      }
    });
    sendWsMessage(state, id, 'query', capabilityQuery);
  });

  const response = await withTimeout(queryPromise, state.config.timeout!, 'Registry request timeout');
  return response.data.nodes.map(toNode).sort((a, b) => (b.reputation || 0) - (a.reputation || 0));
}

export async function setReputation(state: ClientState, nodeId: string, value: number): Promise<void> {
  if (!state.connected) return;

  const baseUrl = state.mode === 'http'
    ? state.config.url
    : state.config.url.replace('ws://', 'http://').replace('wss://', 'https://');

  try {
    await fetch(`${baseUrl}/api/nodes/${nodeId}/reputation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    });
  } catch (error) {
    console.error('Failed to set reputation:', error);
  }
}

export async function incrementReputation(state: ClientState, nodeId: string, increment: number = 1): Promise<void> {
  if (!state.connected) return;

  const baseUrl = state.mode === 'http'
    ? state.config.url
    : state.config.url.replace('ws://', 'http://').replace('wss://', 'https://');

  try {
    const res = await fetch(`${baseUrl}/api/nodes/${nodeId}`);
    if (!res.ok) return;

    const { data } = NodeReputationSchema.parse(await res.json());
    await fetch(`${baseUrl}/api/nodes/${nodeId}/reputation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: data.reputation + increment }),
    });
  } catch (error) {
    console.error('Failed to increment reputation:', error);
  }
}
