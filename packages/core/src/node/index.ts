import type {
  Capability,
  CapabilityQuery,
  CapabilityMatch,
  Message,
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

export { createInitialState, createStateRef, getState, setState, updateState } from './state';
export type { StateRef } from './types';

export interface EccoNode {
  ref: StateRef<NodeState>;
  id: string;
  addrs: string[];
}

export interface EccoOptions {
  onMessage?: (message: Message) => void;
}

export async function ecco(config: EccoConfig, options?: EccoOptions): Promise<EccoNode> {
  const state = createInitialStateImpl(config);
  const ref = await lifecycle.start(state);
  const nodeState = getState(ref);
  const id = nodeState.id;
  const addrs = nodeState.node ? nodeState.node.getMultiaddrs().map(String) : [];
  const libp2pPeerId = nodeState.node?.peerId?.toString();

  if (options?.onMessage) {
    const handler = options.onMessage;
    const messageHandler = (event: EccoEvent) => {
      if (event.type === 'message') {
        handler(event.payload as Message);
      }
    };

    if (libp2pPeerId) {
      subscribeWithRef(ref, `peer:${libp2pPeerId}`, messageHandler);
    }
  }

  return { ref, id, addrs };
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

export function subscribeToTopic(ref: StateRef<NodeState>, topic: string, handler: (event: EccoEvent) => void): void {
  subscribeWithRef(ref, topic, handler);
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
