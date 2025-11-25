import { Effect, Ref } from 'effect';
import { nanoid } from 'nanoid';
import type { NodeState } from './types';
import type { Capability, CapabilityQuery, CapabilityMatch } from '../types';
import { publish, subscribe } from './messaging';
import { Matcher } from '../orchestrator/capability-matcher';
import { updatePeer } from './state-helpers';
import { addPeerRef, updateState, getState, setCapabilityTrackingSetupRef } from './state-ref';
import type { CapabilityAnnouncementEvent, CapabilityRequestEvent, CapabilityResponseEvent, EccoEvent } from '../events';

export async function announceCapabilities(state: NodeState): Promise<void> {
  await CapabilityEffects.announceCapabilities(state);
}

// Pure business logic namespace
namespace CapabilityLogic {
  export function hasCapabilitiesChanged(
    existing: Capability[],
    updated: Capability[]
  ): boolean {
    return JSON.stringify(existing) !== JSON.stringify(updated);
  }

  export function shouldRespondToRequest(
    myNodeId: string,
    requestFrom: string,
    capabilities: Capability[],
    query: CapabilityQuery,
    matcher: ReturnType<typeof Matcher.create>
  ): { shouldRespond: boolean; matches: CapabilityMatch[] } {
    if (requestFrom === myNodeId) {
      return { shouldRespond: false, matches: [] };
    }

    const ourPeerInfo = {
      id: myNodeId,
      addresses: [],
      capabilities,
      lastSeen: Date.now(),
    };

    const matches = Matcher.matchPeers(matcher, [ourPeerInfo], query);
    return {
      shouldRespond: matches.length > 0,
      matches,
    };
  }
}

namespace CapabilityEffects {
  export async function announceCapabilities(state: NodeState): Promise<void> {
    if (state.config.discovery.includes('gossip') && state.node?.services.pubsub) {
      const event: CapabilityAnnouncementEvent = {
        type: 'capability-announcement',
        peerId: state.id,
        capabilities: state.capabilities,
        timestamp: Date.now(),
      };
      await publish(state, 'ecco:capabilities', event);
    }

    if (state.config.discovery.includes('dht') && state.node?.services.dht) {
      const { DHT } = await import('./dht');
      const addresses = state.node.getMultiaddrs().map(String);
      await DHT.announceCapabilities(state.node, state.id, state.capabilities, addresses, {
        waitForReady: true,
        minPeers: 1,
        timeout: 10000,
        retries: 2,
      });
    }
  }

  export async function respondToRequest(
    state: NodeState,
    requestId: string,
    from: string
  ): Promise<void> {
    const event: CapabilityResponseEvent = {
      type: 'capability-response',
      requestId,
      peerId: state.id,
      capabilities: state.capabilities,
      timestamp: Date.now(),
    };
    await publish(state, 'ecco:capability-response', event);
    console.log(`Responded to capability request from ${from}`);
  }
}

export function setupCapabilityTracking(
  stateRef: Ref.Ref<NodeState>
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* getState(stateRef);

    if (state.capabilityTrackingSetup) {
      return;
    }

    // Only set up gossip-based capability tracking if gossipsub is enabled
    if (!state.node?.services.pubsub) {
      console.log('[Capabilities] Gossipsub not enabled, skipping capability tracking setup');
      yield* setCapabilityTrackingSetupRef(stateRef, true);
      return;
    }

    let currentState = state;
    currentState = subscribe(currentState, 'ecco:capabilities', (event) => {
      try {
        if (event.type !== 'capability-announcement') {
          return;
        }

        Effect.runPromise(
          Effect.gen(function* () {
            const currentState = yield* getState(stateRef);
            const peer = currentState.peers.get(event.peerId);

            if (peer) {
              const capabilitiesChanged = CapabilityLogic.hasCapabilitiesChanged(
                peer.capabilities,
                event.capabilities
              );

              if (capabilitiesChanged) {
                console.log(`Updated capabilities for peer ${event.peerId}:`,
                  event.capabilities.map(c => c.name).join(', '));
              }

              yield* updateState(stateRef, (state) =>
                updatePeer(state, event.peerId, {
                  capabilities: event.capabilities,
                  lastSeen: event.timestamp,
                })
              );
            } else {
              console.log(`Added new peer from announcement: ${event.peerId}`);
              yield* addPeerRef(stateRef, {
                id: event.peerId,
                addresses: [],
                capabilities: event.capabilities,
                lastSeen: event.timestamp,
              });
            }
          })
        );
      } catch (error) {
        console.error('Error processing capability announcement:', error);
      }
    });

    currentState = subscribe(currentState, 'ecco:capability-request', async (event) => {
      try {
        if (event.type !== 'capability-request') {
          return;
        }

        const currentState = await Effect.runPromise(getState(stateRef));
        console.log(`[${currentState.id}] Received capability request from ${event.from}`);

        // Ensure the requester is tracked as a peer for accounting/metrics
        if (!currentState.peers.get(event.from)) {
          await Effect.runPromise(addPeerRef(stateRef, {
            id: event.from,
            addresses: [],
            capabilities: [],
            lastSeen: event.timestamp,
          }));
        }

        const query: CapabilityQuery = {
          requiredCapabilities: event.requiredCapabilities,
          preferredPeers: event.preferredPeers,
        };

        const { shouldRespond } = CapabilityLogic.shouldRespondToRequest(
          currentState.id,
          event.from,
          currentState.capabilities,
          query,
          currentState.capabilityMatcher
        );

        console.log(`[${currentState.id}] Should respond: ${shouldRespond}, capabilities: ${currentState.capabilities.map(c => c.name).join(', ')}`);

        if (shouldRespond) {
          await CapabilityEffects.respondToRequest(currentState, event.requestId, event.from);
          console.log(`[${currentState.id}] Sent capability response to ${event.from}`);
        }
      } catch (error) {
        console.error('Error processing capability request:', error);
      }
    });

    yield* Ref.set(stateRef, currentState);
    yield* setCapabilityTrackingSetupRef(stateRef, true);
  });
}

export function requestCapabilities(
  stateRef: Ref.Ref<NodeState>,
  query: CapabilityQuery,
  timeoutMs = 2000
): Effect.Effect<CapabilityMatch[], never> {
  return Effect.gen(function* () {
    let state = yield* getState(stateRef);
    const matchesRef = yield* Ref.make<CapabilityMatch[]>([]);
    const requestId = nanoid();

    const responseHandler = (event: EccoEvent) => {
      try {
        if (event.type !== 'capability-response') {
          return;
        }

        if (event.requestId !== requestId) {
          return;
        }

        console.log(`[${state.id}] Received capability response from ${event.peerId}`);

        Effect.runPromise(
          Effect.gen(function* () {
            const currentState = yield* getState(stateRef);
            const peer = currentState.peers.get(event.peerId);

            if (peer) {
              yield* updateState(stateRef, (state) =>
                updatePeer(state, event.peerId, {
                  capabilities: event.capabilities,
                  lastSeen: event.timestamp,
                })
              );
            } else {
              yield* addPeerRef(stateRef, {
                id: event.peerId,
                addresses: [],
                capabilities: event.capabilities,
                lastSeen: event.timestamp,
              });
            }

            const updatedState = yield* getState(stateRef);
            const peerMatches = Matcher.matchPeers(
              updatedState.capabilityMatcher,
              [updatedState.peers.get(event.peerId)!],
              query
            );
            if (peerMatches.length > 0) {
              yield* Ref.update(matchesRef, (matches) => [...matches, ...peerMatches]);
            }
          })
        );
      } catch (error) {
        console.error('Error processing capability response:', error);
      }
    };

    state = subscribe(state, 'ecco:capability-response', responseHandler);
    yield* Ref.set(stateRef, state);

    const requestEvent: CapabilityRequestEvent = {
      type: 'capability-request',
      requestId,
      from: state.id,
      requiredCapabilities: query.requiredCapabilities,
      preferredPeers: query.preferredPeers,
      timestamp: Date.now(),
    };

    yield* Effect.promise(() => publish(state, 'ecco:capability-request', requestEvent)).pipe(
      Effect.catchAll((error) => {
        console.error('Failed to broadcast capability request:', error);
        return Effect.succeed(void 0);
      })
    );

    // Wait for responses using Effect.sleep instead of setTimeout
    yield* Effect.sleep(`${timeoutMs} millis`);

    return yield* Ref.get(matchesRef);
  });
}
