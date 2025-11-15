import { Effect, Schedule, Fiber } from 'effect';
import type { Capability, CapabilityQuery, PeerInfo } from './types';
import { nanoid } from 'nanoid';
import { withTimeout } from './util';

interface RegistryClientConfig {
  url: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  timeout?: number;
}

interface HttpApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

interface RegistryMessage {
  id: string;
  type: string;
  payload: unknown;
  timestamp: number;
}

export interface ClientState {
  config: RegistryClientConfig;
  ws: WebSocket | null;
  connected: boolean;
  nodeId?: string;
  messageHandlers: Map<string, (response: any) => void>;
  reconnectTimer?: NodeJS.Timeout;
  pingTimer?: NodeJS.Timeout;
  pingFiber?: Fiber.RuntimeFiber<number | void, never>;
  mode?: 'ws' | 'http';
}

// Pure business logic namespace
namespace RegistryLogic {
  export function createMessage(type: string, payload: unknown): RegistryMessage {
    return {
      id: nanoid(),
      type,
      payload,
      timestamp: Date.now(),
    };
  }

  export function isHttpUrl(url: string): boolean {
    return url.startsWith('http://') || url.startsWith('https://');
  }

  export function parseMessage(data: string): { success: boolean; message?: any; error?: string } {
    try {
      const message = JSON.parse(data);
      return { success: true, message };
    } catch (error) {
      return { success: false, error: 'Failed to parse message' };
    }
  }

  export function shouldReconnect(config: RegistryClientConfig): boolean {
    return config.reconnect ?? true;
  }

  export function transformToRegistryNode(node: any): PeerInfo {
    return {
      id: node.nodeId,
      addresses: node.addresses,
      capabilities: node.capabilities,
      lastSeen: node.lastSeen,
      reputation: node.reputation,
    };
  }
}

// I/O Effects namespace
namespace RegistryEffects {
  export function sendWebSocketMessage(ws: WebSocket, message: RegistryMessage): void {
    ws.send(JSON.stringify(message));
  }

  export function closeWebSocket(ws: WebSocket | null): void {
    if (ws) {
      ws.close();
    }
  }

  export async function httpGet<T>(baseUrl: string, path: string): Promise<HttpApiResponse<T>> {
    const res = await fetch(`${baseUrl}${path}`, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return (await res.json()) as HttpApiResponse<T>;
  }

  export async function httpPost<T, B>(baseUrl: string, path: string, body: B): Promise<HttpApiResponse<T>> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let errorMessage = `HTTP ${res.status}`;
      try {
        const errorBody = await res.json() as HttpApiResponse<T>;
        if (errorBody.error) {
          errorMessage = `${errorMessage}: ${errorBody.error}`;
        }
      } catch {
      }
      throw new Error(errorMessage);
    }
    return (await res.json()) as HttpApiResponse<T>;
  }
}

export namespace Registry {
  function handleMessage(state: ClientState, data: string): ClientState {
    const parsed = RegistryLogic.parseMessage(data);

    if (!parsed.success) {
      console.error('Error handling registry message:', parsed.error);
      return state;
    }

    const message = parsed.message;

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
    const pingEffect = Effect.gen(function* () {
      if (!state.connected || !state.nodeId) return;
      if (state.mode === 'http') {
        yield* Effect.promise(() =>
          RegistryEffects.httpPost<{ message: string }, { nodeId: string; timestamp: number }>(
            state.config.url,
            '/api/ping',
            { nodeId: state.nodeId!, timestamp: Date.now() }
          )
        ).pipe(
          Effect.catchAll(() => Effect.succeed(void 0))
        );
        return;
      }
      const message = RegistryLogic.createMessage('ping', {
        nodeId: state.nodeId,
        timestamp: Date.now(),
      });
      yield* Effect.promise(() => sendMessage(state, message)).pipe(
        Effect.catchAll(() => Effect.succeed(void 0))
      );
    });

    const scheduled = pingEffect.pipe(
      Effect.schedule(Schedule.fixed("30 seconds")),
      Effect.catchAll(() => Effect.succeed(void 0))
    );

    const fiber = Effect.runFork(scheduled);

    return { ...state, pingFiber: fiber };
  }

  function stopPingInterval(state: ClientState): ClientState {
    if (state.pingFiber) {
      Effect.runFork(Fiber.interrupt(state.pingFiber));
      return { ...state, pingFiber: undefined };
    }
    return state;
  }

  function scheduleReconnect(state: ClientState): void {
    if (state.reconnectTimer) {
      return;
    }

    console.log(`Reconnecting to registry in ${state.config.reconnectInterval}ms...`);

    const reconnectEffect = Effect.gen(function* () {
      yield* Effect.sleep(`${state.config.reconnectInterval || 5000} millis`);

      yield* Effect.tryPromise({
        try: () => connect({ ...state, reconnectTimer: undefined }),
        catch: (error) => {
          console.error('Reconnection failed:', error);
          scheduleReconnect(state);
          return error;
        }
      });
    });

    Effect.runPromise(reconnectEffect);
  }

  function sendMessage(state: ClientState, message: RegistryMessage): Promise<void> {
    if (!state.connected || !state.ws) {
      throw new Error('Not connected to registry');
    }

    RegistryEffects.sendWebSocketMessage(state.ws, message);
    return Promise.resolve();
  }

  export function create(config: RegistryClientConfig): ClientState {
    return {
      config: {
        reconnect: true,
        reconnectInterval: 5000,
        timeout: 10000,
        ...config,
      },
      ws: null,
      connected: false,
      messageHandlers: new Map(),
      mode: RegistryLogic.isHttpUrl(config.url) ? 'http' : 'ws',
    };
  }

  export async function connect(state: ClientState): Promise<ClientState> {
    if (state.mode === 'http') {
      try {
        await RegistryEffects.httpGet<{ status: 'healthy'; uptime: number; timestamp: number }>(state.config.url, '/health');
        let newState: ClientState = { ...state, connected: true };
        newState = startPingInterval(newState);
        console.log(`Connected to registry (HTTP): ${state.config.url}`);
        return newState;
      } catch (error) {
        throw error;
      }
    }
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(state.config.url);
        let newState: ClientState = { ...state, ws };

        ws.onopen = () => {
          newState = { ...newState, connected: true };
          newState = startPingInterval(newState);
          console.log(`Connected to registry: ${state.config.url}`);
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
          newState = { ...newState, connected: false };
          newState = stopPingInterval(newState);
          console.log('Disconnected from registry');

          if (newState.config.reconnect) {
            scheduleReconnect(newState);
          }
        };

        setTimeout(() => {
          if (!newState.connected) {
            reject(new Error('Connection timeout'));
          }
        }, state.config.timeout);
      } catch (error) {
        reject(error);
      }
    });
  }

  export async function disconnect(state: ClientState): Promise<ClientState> {
    const newConfig: RegistryClientConfig = { ...state.config, reconnect: false };
    let newState: ClientState = { ...state, config: newConfig };

    if (newState.reconnectTimer) {
      clearTimeout(newState.reconnectTimer);
      newState = { ...newState, reconnectTimer: undefined };
    }

    newState = stopPingInterval(newState);

    if (newState.mode === 'ws') {
      RegistryEffects.closeWebSocket(newState.ws);
      newState = { ...newState, ws: null, connected: false };
      return newState;
    }
    newState = { ...newState, connected: false };

    return newState;
  }

  export async function register(
    state: ClientState,
    nodeId: string,
    capabilities: Capability[],
    addresses: string[]
  ): Promise<ClientState> {
    if (state.mode === 'http') {
      const payload: {
        nodeId: string;
        capabilities: Array<{
          type: string;
          name: string;
          version: string;
          metadata?: Record<string, unknown>;
        }>;
        addresses: string[];
      } = {
        nodeId,
        capabilities: capabilities.map(c => {
          const cap: {
            type: string;
            name: string;
            version: string;
            metadata?: Record<string, unknown>;
          } = {
            type: c.type,
            name: c.name,
            version: c.version,
          };
          if (c.metadata) {
            cap.metadata = c.metadata;
          }
          return cap;
        }),
        addresses,
      };
      const res = await RegistryEffects.httpPost<{ message: string }, typeof payload>(state.config.url, '/api/register', payload);
      if (!res.success) {
        throw new Error(res.error || 'Register failed');
      }
      const newState: ClientState = { ...state, nodeId };
      return newState;
    }
    const newState = { ...state, nodeId };
    const message = RegistryLogic.createMessage('register', {
      nodeId,
      capabilities,
      addresses,
    });
    await sendMessage(newState, message);
    return newState;
  }

  export async function unregister(state: ClientState): Promise<ClientState> {
    if (!state.nodeId) {
      return state;
    }

    if (state.mode === 'http') {
      await RegistryEffects.httpPost<{ message: string }, { nodeId: string }>(state.config.url, '/api/unregister', {
        nodeId: state.nodeId,
      });
      return { ...state, nodeId: undefined };
    }
    const message = RegistryLogic.createMessage('unregister', {
      nodeId: state.nodeId,
    });
    await sendMessage(state, message);
    return { ...state, nodeId: undefined };
  }

  export async function query(state: ClientState, query: CapabilityQuery): Promise<PeerInfo[]> {
    if (state.mode === 'http') {
      const params = new URLSearchParams();
      const first = query.requiredCapabilities[0];
      if (first?.type) params.set('type', first.type);
      if (first?.name) params.set('name', first.name);
      const res = await RegistryEffects.httpGet<{ nodes: { nodeId: string; addresses: string[]; capabilities: Capability[]; lastSeen: number; reputation: number }[]; count: number }>(
        state.config.url,
        `/api/capabilities/search?${params.toString()}`
      );
      if (res.success && res.data) {
        const nodes = res.data.nodes.map(RegistryLogic.transformToRegistryNode);
        return nodes.sort((a, b) => (b.reputation || 0) - (a.reputation || 0));
      }
      return [];
    }
    const message = RegistryLogic.createMessage('query', query);
    const response = await sendMessageWithResponse(state, message);
    if (response.success && response.data?.nodes) {
      const nodes = response.data.nodes.map(RegistryLogic.transformToRegistryNode);
      return nodes.sort((a: PeerInfo, b: PeerInfo) => (b.reputation || 0) - (a.reputation || 0));
    }
    return [];
  }

  async function sendMessageWithResponse(state: ClientState, message: RegistryMessage): Promise<any> {
    return withTimeout(
      new Promise((resolve, reject) => {
        state.messageHandlers.set(message.id, (response) => {
          if (response.success) {
            resolve(response);
          } else {
            reject(new Error(response.error || 'Unknown error'));
          }
        });

        sendMessage(state, message).catch(reject);
      }),
      state.config.timeout!,
      'Registry request timeout'
    );
  }

  export function isConnected(state: ClientState): boolean {
    return state.connected;
  }

  export async function setReputation(
    state: ClientState,
    nodeId: string,
    value: number
  ): Promise<void> {
    if (!state.connected) {
      return;
    }

    try {
      const baseUrl = state.mode === 'http' 
        ? state.config.url 
        : state.config.url.replace('ws://', 'http://').replace('wss://', 'https://');
      
      await RegistryEffects.httpPost<{ message: string }, { value: number }>(
        baseUrl,
        `/api/nodes/${nodeId}/reputation`,
        { value }
      );
    } catch (error) {
      console.error('Failed to set reputation:', error);
    }
  }

  export async function incrementReputation(
    state: ClientState,
    nodeId: string,
    increment: number = 1
  ): Promise<void> {
    if (!state.connected) {
      return;
    }

    try {
      const baseUrl = state.mode === 'http' 
        ? state.config.url 
        : state.config.url.replace('ws://', 'http://').replace('wss://', 'https://');
      
      const nodeRes = await RegistryEffects.httpGet<{ nodeId: string; reputation: number; capabilities: unknown[]; addresses: string[]; registeredAt: number; lastSeen: number; connectionId: string }>(
        baseUrl,
        `/api/nodes/${nodeId}`
      );
      
      if (nodeRes.success && nodeRes.data) {
        const currentReputation = nodeRes.data.reputation || 0;
        const newReputation = currentReputation + increment;
        
        await RegistryEffects.httpPost<{ message: string }, { value: number }>(
          baseUrl,
          `/api/nodes/${nodeId}/reputation`,
          { value: newReputation }
        );
      }
    } catch (error) {
      console.error('Failed to increment reputation:', error);
    }
  }
}
