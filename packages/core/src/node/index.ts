import { Effect, Ref } from 'effect';
import type {
  EccoConfig,
  Capability,
  CapabilityQuery,
  CapabilityMatch,
  Message,
  PeerInfo,
} from '../types';
import { createNodeState } from './create';
import * as lifecycle from './lifecycle';
import { getState } from './state-ref';
import type { NodeState } from './types';
import type { EccoEvent } from '../events';

export namespace Node {
  export function create(config: EccoConfig): NodeState {
    return createNodeState(config);
  }

  export async function start(state: NodeState): Promise<NodeState> {
    const stateRef = await lifecycle.start(state);
    const currentState = await Effect.runPromise(getState(stateRef));
    return { ...currentState, _ref: stateRef };
  }

  export async function stop(state: NodeState): Promise<void> {
    if (!state._ref) {
      throw new Error('Node state does not have a ref. Did you call Node.start()?');
    }
    await lifecycle.stop(state._ref);
  }

  export async function publish(state: NodeState, topic: string, event: EccoEvent): Promise<void> {
    if (!state._ref) {
      throw new Error('Node state does not have a ref. Did you call Node.start()?');
    }
    const currentState = await Effect.runPromise(getState(state._ref));
    const { publish: publishFn } = await import('./messaging');
    await publishFn(currentState, topic, event);
  }

  export function subscribeToTopic(state: NodeState, topic: string, handler: (event: EccoEvent) => void): NodeState {
    if (!state._ref) {
      throw new Error('Node state does not have a ref. Did you call Node.start()?');
    }
    const { subscribe } = require('./messaging');
    const updatedState = subscribe(state, topic, handler);
    Effect.runSync(Ref.set(state._ref, updatedState));
    return updatedState;
  }

  export async function findPeers(
    state: NodeState,
    query: CapabilityQuery
  ): Promise<{ matches: CapabilityMatch[]; state: NodeState }> {
    if (!state._ref) {
      throw new Error('Node state does not have a ref. Did you call Node.start()?');
    }
    const matches = await lifecycle.findPeers(state._ref, query);
    const updatedState = await Effect.runPromise(getState(state._ref));
    return { matches, state: { ...updatedState, _ref: state._ref } };
  }

  export async function sendMessage(state: NodeState, peerId: string, message: Message): Promise<NodeState> {
    if (!state._ref) {
      throw new Error('Node state does not have a ref. Did you call Node.start()?');
    }
    await lifecycle.sendMessage(state._ref, peerId, message);
    const updatedState = await Effect.runPromise(getState(state._ref));
    return { ...updatedState, _ref: state._ref };
  }

  export function getCapabilities(state: NodeState): Capability[] {
    return [...state.capabilities];
  }

  export async function addCapability(state: NodeState, capability: Capability): Promise<NodeState> {
    if (!state._ref) {
      throw new Error('Node state does not have a ref. Did you call Node.start()?');
    }
    const newState = { ...state, capabilities: [...state.capabilities, capability], _ref: state._ref };
    await Effect.runPromise(Ref.set(state._ref, newState));
    const { announceCapabilities } = await import('./capabilities');
    await announceCapabilities(newState);
    return newState;
  }

  export function getPeers(state: NodeState): PeerInfo[] {
    return Array.from(state.peers.values());
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

  export async function isRegistryConnected(state: NodeState): Promise<boolean> {
    if (!state._ref || !state.registryClientRef) {
      return false;
    }
    const { RegistryService, ServicesLive } = await import('../services');
    const program = Effect.gen(function* () {
      const registryService = yield* RegistryService;
      return yield* registryService.isConnected(state.registryClientRef!);
    }).pipe(Effect.provide(ServicesLive));
    return Effect.runPromise(program);
  }

  export async function setRegistryReputation(
    state: NodeState,
    nodeId: string,
    value: number
  ): Promise<void> {
    if (!state._ref || !state.registryClientRef) {
      throw new Error('Node not connected to registry');
    }
    const { Registry } = await import('../registry-client');
    const registryState = await Effect.runPromise(Ref.get(state.registryClientRef));
    await Registry.setReputation(registryState, nodeId, value);
  }

  export async function incrementRegistryReputation(
    state: NodeState,
    nodeId: string,
    increment: number = 1
  ): Promise<void> {
    if (!state._ref || !state.registryClientRef) {
      throw new Error('Node not connected to registry');
    }
    const { Registry } = await import('../registry-client');
    const registryState = await Effect.runPromise(Ref.get(state.registryClientRef));
    await Registry.incrementReputation(registryState, nodeId, increment);
  }
}

export type { NodeState } from './types';
