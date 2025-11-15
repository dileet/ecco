import { z } from 'zod';
import type { Capability, PeerInfo } from './types';

const CapabilitySchema = z.object({
  type: z.string(),
  name: z.string(),
  version: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const PeerInfoSchema = z.object({
  id: z.string(),
  addresses: z.array(z.string()),
  capabilities: z.array(CapabilitySchema),
  lastSeen: z.number(),
  servicesProvided: z.number().optional(),
  servicesConsumed: z.number().optional(),
});

const CapabilityAnnouncementEventSchema = z.object({
  type: z.literal('capability-announcement'),
  peerId: z.string(),
  capabilities: z.array(CapabilitySchema),
  timestamp: z.number(),
});

const CapabilityRequestEventSchema = z.object({
  type: z.literal('capability-request'),
  requestId: z.string(),
  from: z.string(),
  requiredCapabilities: z.array(CapabilitySchema.partial()),
  preferredPeers: z.array(z.string()).optional(),
  timestamp: z.number(),
});

const CapabilityResponseEventSchema = z.object({
  type: z.literal('capability-response'),
  requestId: z.string(),
  peerId: z.string(),
  capabilities: z.array(CapabilitySchema),
  timestamp: z.number(),
});

const PeerDiscoveredEventSchema = z.object({
  type: z.literal('peer-discovered'),
  peer: PeerInfoSchema,
  timestamp: z.number(),
});

const PeerDisconnectedEventSchema = z.object({
  type: z.literal('peer-disconnected'),
  peerId: z.string(),
  timestamp: z.number(),
});

const MessageEventSchema = z.object({
  type: z.literal('message'),
  from: z.string(),
  to: z.string(),
  payload: z.unknown(),
  timestamp: z.number(),
});

const EccoEventSchema = z.discriminatedUnion('type', [
  CapabilityAnnouncementEventSchema,
  CapabilityRequestEventSchema,
  CapabilityResponseEventSchema,
  PeerDiscoveredEventSchema,
  PeerDisconnectedEventSchema,
  MessageEventSchema,
]);

export type CapabilityAnnouncementEvent = z.infer<typeof CapabilityAnnouncementEventSchema>;
export type CapabilityRequestEvent = z.infer<typeof CapabilityRequestEventSchema>;
export type CapabilityResponseEvent = z.infer<typeof CapabilityResponseEventSchema>;
export type PeerDiscoveredEvent = z.infer<typeof PeerDiscoveredEventSchema>;
export type PeerDisconnectedEvent = z.infer<typeof PeerDisconnectedEventSchema>;
export type MessageEvent = z.infer<typeof MessageEventSchema>;

export type EccoEvent = z.infer<typeof EccoEventSchema>;

export namespace EventBus {
  export function validate(event: unknown): EccoEvent {
    return EccoEventSchema.parse(event);
  }

  export function isValid(event: unknown): event is EccoEvent {
    return EccoEventSchema.safeParse(event).success;
  }

  export function createCapabilityAnnouncement(
    peerId: string,
    capabilities: Capability[]
  ): CapabilityAnnouncementEvent {
    return {
      type: 'capability-announcement',
      peerId,
      capabilities,
      timestamp: Date.now(),
    };
  }

  export function createCapabilityRequest(
    requestId: string,
    from: string,
    requiredCapabilities: Partial<Capability>[],
    preferredPeers?: string[]
  ): CapabilityRequestEvent {
    return {
      type: 'capability-request',
      requestId,
      from,
      requiredCapabilities,
      preferredPeers,
      timestamp: Date.now(),
    };
  }

  export function createCapabilityResponse(
    requestId: string,
    peerId: string,
    capabilities: Capability[]
  ): CapabilityResponseEvent {
    return {
      type: 'capability-response',
      requestId,
      peerId,
      capabilities,
      timestamp: Date.now(),
    };
  }

  export function createPeerDiscovered(peer: PeerInfo): PeerDiscoveredEvent {
    return {
      type: 'peer-discovered',
      peer,
      timestamp: Date.now(),
    };
  }

  export function createPeerDisconnected(peerId: string): PeerDisconnectedEvent {
    return {
      type: 'peer-disconnected',
      peerId,
      timestamp: Date.now(),
    };
  }

  export function createMessage(
    from: string,
    to: string,
    payload: unknown
  ): MessageEvent {
    return {
      type: 'message',
      from,
      to,
      payload,
      timestamp: Date.now(),
    };
  }
}
