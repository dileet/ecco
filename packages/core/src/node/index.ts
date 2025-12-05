import type {
  Capability,
  CapabilityQuery,
  CapabilityMatch,
  Message,
  MessageType,
  EccoConfig,
} from '../types';
import { createInitialState as createInitialStateImpl, getState, setState } from './state';
import * as lifecycle from './lifecycle';
import { findPeers as findPeersImpl } from './discovery';
import type { NodeState, StateRef } from './types';
import type { EccoEvent } from '../events';
import { publish as publishFn, subscribeWithRef } from './messaging';
import { announceCapabilities } from './capabilities';
import { setReputation, incrementReputation } from '../registry-client';
import { signMessage, verifyMessage, isMessageFresh, type AuthState, type SignedMessage } from '../services/auth';
import { getAddress, type WalletState } from '../services/wallet';

export { 
  createInitialState,
  createStateRef, 
  getState, 
  getVersion, 
  setState, 
  updateState,
  addPeer,
  removePeer,
  updatePeer,
  addPeers,
  getPeer,
  hasPeer,
  getAllPeers,
  getPeerCount,
  evictStalePeers,
} from './state';
export type { StateRef } from './types';

export interface Agent {
  ref: StateRef<NodeState>;
  id: string;
  addrs: string[];
  auth: AuthState;
  wallet: WalletState | null;
  address: string | null;
  signAndSend: (peerId: string, message: Message) => Promise<void>;
}

export interface MessageContext {
  agent: Agent;
  reply: (payload: unknown, type?: MessageType) => Promise<void>;
}

export interface AgentCallbacks {
  onMessage?: (message: Message, ctx: MessageContext) => void | Promise<void>;
  onUnverifiedMessage?: (message: Message) => void | Promise<void>;
}

export interface EccoNode {
  ref: StateRef<NodeState>;
  id: string;
  addrs: string[];
}

export async function createAgent(config: EccoConfig, callbacks?: AgentCallbacks): Promise<Agent> {
  const state = createInitialStateImpl(config);
  const ref = await lifecycle.start(state);
  const nodeState = getState(ref);
  const libp2pPeerId = nodeState.node?.peerId?.toString();
  const id = libp2pPeerId ?? nodeState.id;
  const addrs = nodeState.node ? nodeState.node.getMultiaddrs().map(String) : [];

  const authState: AuthState = nodeState.messageAuth ?? {
    config: { enabled: false },
    keyCache: new Map(),
  };

  const walletState = nodeState.wallet ?? null;
  const walletAddress = walletState ? getAddress(walletState) : null;

  const signAndSend = async (peerId: string, message: Message): Promise<void> => {
    let messageToSend = message;
    if (authState.config.enabled) {
      messageToSend = await signMessage(authState, message);
    }
    await lifecycle.sendMessage(ref, peerId, messageToSend);
  };

  const agent: Agent = {
    ref,
    id,
    addrs,
    auth: authState,
    wallet: walletState,
    address: walletAddress,
    signAndSend,
  };

  if (callbacks?.onMessage || callbacks?.onUnverifiedMessage) {
    const wrappedHandler = async (message: Message): Promise<void> => {
      const authEnabled = authState.config.enabled;

      if (message.signature && message.publicKey) {
        const { valid } = await verifyMessage(authState, message as SignedMessage);
        if (!valid) {
          console.warn(`[${id}] Rejected message with invalid signature from ${message.from}`);
          if (callbacks.onUnverifiedMessage) {
            await callbacks.onUnverifiedMessage(message);
          }
          return;
        }
        if (!isMessageFresh(message)) {
          console.warn(`[${id}] Rejected stale message from ${message.from}`);
          if (callbacks.onUnverifiedMessage) {
            await callbacks.onUnverifiedMessage(message);
          }
          return;
        }
      } else if (authEnabled) {
        console.warn(`[${id}] Received unsigned message from ${message.from}`);
        if (callbacks.onUnverifiedMessage) {
          await callbacks.onUnverifiedMessage(message);
        }
        return;
      }

      if (callbacks.onMessage) {
        const ctx: MessageContext = {
          agent,
          reply: async (payload: unknown, type: MessageType = 'agent-response') => {
            const replyMessage: Message = {
              id: crypto.randomUUID(),
              from: id,
              to: message.from,
              type,
              payload,
              timestamp: Date.now(),
            };
            await agent.signAndSend(message.from, replyMessage);
          },
        };

        await callbacks.onMessage(message, ctx);
      }
    };

    const messageHandler = (event: EccoEvent): void => {
      if (event.type === 'message') {
        wrappedHandler(event.payload as Message).catch((err) => {
          console.error(`[${id}] Error handling message:`, err);
        });
      }
    };

    if (libp2pPeerId) {
      subscribeWithRef(ref, `peer:${libp2pPeerId}`, messageHandler);
    }

    if (nodeState.messageBridge) {
      const { subscribeToAllDirectMessages } = await import('../transport/message-bridge');
      const updatedBridge = subscribeToAllDirectMessages(nodeState.messageBridge, wrappedHandler);
      setState(ref, { ...getState(ref), messageBridge: updatedBridge });
    }
  }

  return agent;
}

export async function start(state: NodeState): Promise<StateRef<NodeState>> {
  return lifecycle.start(state);
}

export async function stop(ref: StateRef<NodeState>): Promise<void> {
  await lifecycle.stop(ref);
}

export async function publish(ref: StateRef<NodeState>, topic: string, event: EccoEvent): Promise<void> {
  const state = getState(ref);
  await publishFn(state, topic, event);
}

export function subscribeToTopic(ref: StateRef<NodeState>, topic: string, handler: (event: EccoEvent) => void): () => void {
  return subscribeWithRef(ref, topic, handler);
}

export async function findPeers(
  ref: StateRef<NodeState>,
  query?: CapabilityQuery
): Promise<CapabilityMatch[]> {
  const effectiveQuery: CapabilityQuery = query ?? { requiredCapabilities: [] };
  return findPeersImpl(ref, effectiveQuery);
}

export async function sendMessage(ref: StateRef<NodeState>, peerId: string, message: Message): Promise<void> {
  await lifecycle.sendMessage(ref, peerId, message);
}

export function getCapabilities(ref: StateRef<NodeState>): Capability[] {
  const state = getState(ref);
  return [...state.capabilities];
}

export async function addCapability(ref: StateRef<NodeState>, capability: Capability): Promise<void> {
  const state = getState(ref);
  const newState = { ...state, capabilities: [...state.capabilities, capability] };
  setState(ref, newState);
  await announceCapabilities(newState);
}

export function getMultiaddrs(ref: StateRef<NodeState>): string[] {
  const state = getState(ref);
  if (!state.node) {
    return [];
  }
  return state.node.getMultiaddrs().map(String);
}

export function getId(ref: StateRef<NodeState>): string {
  const state = getState(ref);
  return state.id;
}

export function getLibp2pPeerId(ref: StateRef<NodeState>): string | undefined {
  const state = getState(ref);
  return state.node?.peerId?.toString();
}

export function isRegistryConnected(ref: StateRef<NodeState>): boolean {
  const state = getState(ref);
  return state.registryClient?.connected ?? false;
}

export async function setRegistryReputation(
  ref: StateRef<NodeState>,
  nodeId: string,
  value: number
): Promise<void> {
  const state = getState(ref);
  if (!state.registryClient) {
    throw new Error('Node not connected to registry');
  }
  await setReputation(state.registryClient, nodeId, value);
}

export async function incrementRegistryReputation(
  ref: StateRef<NodeState>,
  nodeId: string,
  increment: number = 1
): Promise<void> {
  const state = getState(ref);
  if (!state.registryClient) {
    throw new Error('Node not connected to registry');
  }
  await incrementReputation(state.registryClient, nodeId, increment);
}

export async function broadcastCapabilities(ref: StateRef<NodeState>): Promise<void> {
  const state = getState(ref);
  await announceCapabilities(state);
}

export type { NodeState } from './types';
