/**
 * Registry types and schemas
 */

import { z } from 'zod';

export interface RegistryConfig {
  httpPort: number;
  redis: {
    host: string;
    port: number;
    password?: string;
    db?: number;
  };
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  rateLimit: {
    enabled: boolean;
    maxRequests: number;
    windowMs: number;
  };
  nodeTimeout: number;
  cleanupInterval: number;
}

// Zod schemas for validation
export const CapabilitySchema = z.object({
  type: z.string(),
  name: z.string(),
  version: z.string(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export const NodeRegistrationSchema = z.object({
  nodeId: z.string(),
  capabilities: z.array(CapabilitySchema),
  addresses: z.array(z.string()),
  metadata: z.record(z.string(), z.any()).optional(),
});

export const CapabilityQuerySchema = z.object({
  type: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  limit: z.number().min(1).max(100).default(10),
});

export const PingSchema = z.object({
  nodeId: z.string(),
  timestamp: z.number(),
});

// Message types
export type MessageType =
  | 'register'
  | 'unregister'
  | 'query'
  | 'ping'
  | 'subscribe'
  | 'unsubscribe';

export const WebSocketMessageSchema = z.object({
  id: z.string(),
  type: z.enum(['register', 'unregister', 'query', 'ping', 'subscribe', 'unsubscribe']),
  payload: z.unknown(),
  timestamp: z.number(),
});

// Domain types
export type Capability = z.infer<typeof CapabilitySchema>;
export type NodeRegistration = z.infer<typeof NodeRegistrationSchema>;
export type CapabilityQuery = z.infer<typeof CapabilityQuerySchema>;
export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>;

export interface RegisteredNode {
  nodeId: string;
  capabilities: Capability[];
  addresses: string[];
  metadata?: Record<string, unknown>;
  reputation: number;
  registeredAt: number;
  lastSeen: number;
  connectionId: string;
}

export interface NodeMatch {
  node: RegisteredNode;
  matchScore: number;
  matchedCapabilities: Capability[];
}

// API Response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

export interface RegistryStats {
  totalNodes: number;
  activeNodes: number;
  totalCapabilities: number;
  uptime: number;
  messagesProcessed: number;
  averageLatency: number;
}

// Database schemas
export interface NodeRecord {
  id: string;
  node_id: string;
  capabilities: Capability[];
  addresses: string[];
  metadata: Record<string, unknown> | null;
  reputation: number;
  registered_at: Date;
  last_seen: Date;
  created_at: Date;
  updated_at: Date;
}

export interface CapabilityRecord {
  id: string;
  node_id: string;
  type: string;
  name: string;
  version: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface EventRecord {
  id: string;
  event_type: string;
  node_id: string;
  data: Record<string, unknown>;
  created_at: Date;
}
