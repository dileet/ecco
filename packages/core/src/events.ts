import { z } from 'zod';

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
  libp2pPeerId: z.string().optional(),
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
  libp2pPeerId: z.string().optional(),
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

export { MessageEventSchema };

export function validateEvent(event: unknown): EccoEvent {
  return EccoEventSchema.parse(event);
}

export function isValidEvent(event: unknown): event is EccoEvent {
  return EccoEventSchema.safeParse(event).success;
}
