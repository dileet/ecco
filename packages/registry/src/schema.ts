import { pgTable, text, jsonb, timestamp, index, doublePrecision } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const nodes = pgTable('nodes', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull().unique(),
  addresses: text('addresses').array().notNull(),
  metadata: jsonb('metadata'),
  reputation: doublePrecision('reputation').notNull().default(0),
  registeredAt: timestamp('registered_at').notNull(),
  lastSeen: timestamp('last_seen').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('idx_nodes_last_seen').on(table.lastSeen),
]);

export const capabilities = pgTable('capabilities', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull().references(() => nodes.nodeId, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('idx_capabilities_type').on(table.type),
  index('idx_capabilities_name').on(table.name),
  index('idx_capabilities_type_name').on(table.type, table.name),
  index('idx_capabilities_node_id').on(table.nodeId),
]);

export const nodesRelations = relations(nodes, ({ many }) => ({
  capabilities: many(capabilities),
}));

export const capabilitiesRelations = relations(capabilities, ({ one }) => ({
  node: one(nodes, {
    fields: [capabilities.nodeId],
    references: [nodes.nodeId],
  }),
}));

export const events = pgTable('events', {
  id: text('id').primaryKey(),
  eventType: text('event_type').notNull(),
  nodeId: text('node_id'),
  data: jsonb('data').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('idx_events_type').on(table.eventType),
  index('idx_events_created_at').on(table.createdAt),
]);
