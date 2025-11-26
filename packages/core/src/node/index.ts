import type {
  Capability,
  CapabilityQuery,
  CapabilityMatch,
  Message,
  PeerInfo,
} from '../types';
import { getState, setState } from './state';
import * as lifecycle from './lifecycle';
import type { NodeState, StateRef } from './types';
import type { EccoEvent } from '../events';

export { createInitialState, createStateRef, getState, setState, updateState } from './state';
export type { StateRef } from './types';

export async function start(state: NodeState): Promise<StateRef<NodeState>> {
  return lifecycle.start(state);
}

export async function stop(ref: StateRef<NodeState>): Promise<void> {
  await lifecycle.stop(ref);
}

export async function publish(ref: StateRef<NodeState>, topic: string, event: EccoEvent): Promise<void> {
  const state = getState(ref);
  const { publish: publishFn } = await import('./messaging');
  await publishFn(state, topic, event);
}

export function subscribeToTopic(ref: StateRef<NodeState>, topic: string, handler: (event: EccoEvent) => void): void {
  const state = getState(ref);
  const { subscribe } = require('./messaging');
  const updatedState = subscribe(state, topic, handler);
  setState(ref, updatedState);
}

export async function findPeers(
  ref: StateRef<NodeState>,
  query: CapabilityQuery
): Promise<CapabilityMatch[]> {
  return lifecycle.findPeers(ref, query);
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
  const { announceCapabilities } = await import('./capabilities');
  await announceCapabilities(newState);
}

export function getPeers(ref: StateRef<NodeState>): PeerInfo[] {
  const state = getState(ref);
  return Object.values(state.peers);
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
  const { setReputation } = await import('../registry-client');
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
  const { incrementReputation } = await import('../registry-client');
  await incrementReputation(state.registryClient, nodeId, increment);
}

export type { NodeState } from './types';
