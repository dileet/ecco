import type {
  EccoConfig,
  Capability,
  CapabilityQuery,
  CapabilityMatch,
  Message,
  PeerInfo,
} from '../types';
import { createInitialState, getState, setState, updateState } from './state';
import * as lifecycle from './lifecycle';
import type { NodeState, StateRef } from './types';
import type { EccoEvent } from '../events';

interface NodeStateWithRef extends NodeState {
  _ref?: StateRef<NodeState>;
}

export namespace Node {
  export function create(config: EccoConfig): NodeState {
    return createInitialState(config);
  }

  export async function start(state: NodeState): Promise<NodeStateWithRef> {
    const stateRef = await lifecycle.start(state);
    const currentState = getState(stateRef);
    return { ...currentState, _ref: stateRef };
  }

  export async function stop(state: NodeStateWithRef): Promise<void> {
    if (!state._ref) {
      throw new Error('Node state does not have a ref. Did you call Node.start()?');
    }
    await lifecycle.stop(state._ref);
  }

  export async function publish(state: NodeStateWithRef, topic: string, event: EccoEvent): Promise<void> {
    if (!state._ref) {
      throw new Error('Node state does not have a ref. Did you call Node.start()?');
    }
    const currentState = getState(state._ref);
    const { publish: publishFn } = await import('./messaging');
    await publishFn(currentState, topic, event);
  }

  export function subscribeToTopic(state: NodeStateWithRef, topic: string, handler: (event: EccoEvent) => void): NodeStateWithRef {
    if (!state._ref) {
      throw new Error('Node state does not have a ref. Did you call Node.start()?');
    }
    const currentState = getState(state._ref);
    const { subscribe } = require('./messaging');
    const updatedState = subscribe({ ...currentState, _ref: state._ref }, topic, handler);
    setState(state._ref, updatedState);
    return { ...updatedState, _ref: state._ref };
  }

  export async function findPeers(
    state: NodeStateWithRef,
    query: CapabilityQuery
  ): Promise<{ matches: CapabilityMatch[]; state: NodeStateWithRef }> {
    if (!state._ref) {
      throw new Error('Node state does not have a ref. Did you call Node.start()?');
    }
    const matches = await lifecycle.findPeers(state._ref, query);
    const updatedState = getState(state._ref);
    return { matches, state: { ...updatedState, _ref: state._ref } };
  }

  export async function sendMessage(state: NodeStateWithRef, peerId: string, message: Message): Promise<NodeStateWithRef> {
    if (!state._ref) {
      throw new Error('Node state does not have a ref. Did you call Node.start()?');
    }
    await lifecycle.sendMessage(state._ref, peerId, message);
    const updatedState = getState(state._ref);
    return { ...updatedState, _ref: state._ref };
  }

  export function getCapabilities(state: NodeState): Capability[] {
    return [...state.capabilities];
  }

  export async function addCapability(state: NodeStateWithRef, capability: Capability): Promise<NodeStateWithRef> {
    if (!state._ref) {
      throw new Error('Node state does not have a ref. Did you call Node.start()?');
    }
    const newState = { ...state, capabilities: [...state.capabilities, capability], _ref: state._ref };
    setState(state._ref, newState);
    const { announceCapabilities } = await import('./capabilities');
    await announceCapabilities(newState);
    return newState;
  }

  export function getPeers(state: NodeState): PeerInfo[] {
    return Object.values(state.peers);
  }

  export function getMultiaddrs(state: NodeState): string[] {
    if (!state.node) {
      return [];
    }
    return state.node.getMultiaddrs().map(String);
  }

  export function getId(state: NodeState): string {
    return state.id;
  }

  export function isRegistryConnected(state: NodeState): boolean {
    return state.registryClient?.connected ?? false;
  }

  export async function setRegistryReputation(
    state: NodeState,
    nodeId: string,
    value: number
  ): Promise<void> {
    if (!state.registryClient) {
      throw new Error('Node not connected to registry');
    }
    const { setReputation } = await import('../registry-client');
    await setReputation(state.registryClient, nodeId, value);
  }

  export async function incrementRegistryReputation(
    state: NodeState,
    nodeId: string,
    increment: number = 1
  ): Promise<void> {
    if (!state.registryClient) {
      throw new Error('Node not connected to registry');
    }
    const { incrementReputation } = await import('../registry-client');
    await incrementReputation(state.registryClient, nodeId, increment);
  }
}

export type { NodeState } from './types';
