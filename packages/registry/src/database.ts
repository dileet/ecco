import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, and, gt, lt, desc, sql, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as schema from './schema';
import type { RegisteredNode, Capability } from './types';

let db: ReturnType<typeof drizzle> | null = null;
let pool: Pool | null = null;

function getDb() {
  if (!db) {
    const host = process.env.POSTGRES_HOST || 'localhost';
    const port = parseInt(process.env.POSTGRES_PORT || '5432');
    const database = process.env.POSTGRES_DB || 'ecco_registry';
    const user = process.env.POSTGRES_USER || 'postgres';
    const password = process.env.POSTGRES_PASSWORD || 'postgres';

    pool = new Pool({
      host,
      port,
      database,
      user,
      password,
    });

    db = drizzle(pool);
  }
  return db;
}

export async function initialize(): Promise<void> {
  getDb();
}

export async function saveNode(node: RegisteredNode): Promise<void> {
  const database = getDb();
  const now = new Date();

  await database
    .insert(schema.nodes)
    .values({
      id: node.nodeId,
      nodeId: node.nodeId,
      addresses: node.addresses,
      metadata: node.metadata,
      reputation: node.reputation,
      registeredAt: new Date(node.registeredAt),
      lastSeen: new Date(node.lastSeen),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.nodes.nodeId,
      set: {
        addresses: node.addresses,
        metadata: node.metadata,
        reputation: node.reputation,
        registeredAt: new Date(node.registeredAt),
        lastSeen: new Date(node.lastSeen),
        updatedAt: now,
      },
    });

  await database.delete(schema.capabilities).where(eq(schema.capabilities.nodeId, node.nodeId));

  for (const capability of node.capabilities) {
    await database.insert(schema.capabilities).values({
      id: `${node.nodeId}-${capability.type}-${capability.name}`,
      nodeId: node.nodeId,
      type: capability.type,
      name: capability.name,
      version: capability.version,
      metadata: capability.metadata,
    });
  }
}

export async function updateNodeLastSeen(nodeId: string): Promise<void> {
  const database = getDb();
  await database
    .update(schema.nodes)
    .set({ lastSeen: new Date(), updatedAt: new Date() })
    .where(eq(schema.nodes.nodeId, nodeId));
}

export async function updateNodeReputation(nodeId: string, value: number): Promise<void> {
  const database = getDb();
  await database
    .update(schema.nodes)
    .set({ reputation: value, updatedAt: new Date() })
    .where(eq(schema.nodes.nodeId, nodeId));
}

export async function getNode(nodeId: string): Promise<RegisteredNode | null> {
  const database = getDb();
  const nodeResult = await database
    .select()
    .from(schema.nodes)
    .where(eq(schema.nodes.nodeId, nodeId))
    .limit(1);

  if (nodeResult.length === 0) {
    return null;
  }

  const node = nodeResult[0];
  const capabilitiesResult = await database
    .select()
    .from(schema.capabilities)
    .where(eq(schema.capabilities.nodeId, nodeId));

  const capabilities: Capability[] = capabilitiesResult.map((cap) => ({
    type: cap.type,
    name: cap.name,
    version: cap.version,
    metadata: cap.metadata as Record<string, unknown> | undefined,
  }));

  return {
    nodeId: node.nodeId,
    capabilities,
    addresses: node.addresses,
    metadata: node.metadata as Record<string, unknown> | undefined,
    reputation: (node as { reputation: number }).reputation,
    registeredAt: node.registeredAt.getTime(),
    lastSeen: node.lastSeen.getTime(),
    connectionId: '',
  };
}

export async function getAllNodes(): Promise<RegisteredNode[]> {
  const database = getDb();
  const nodesResult = await database.select().from(schema.nodes).orderBy(desc(schema.nodes.lastSeen));

  const nodeIds = nodesResult.map((node) => node.nodeId);
  const capabilitiesResult = nodeIds.length > 0
    ? await database
        .select()
        .from(schema.capabilities)
        .where(inArray(schema.capabilities.nodeId, nodeIds))
    : [];

  const capabilitiesByNodeId = new Map<string, Capability[]>();
  for (const cap of capabilitiesResult) {
    const existing = capabilitiesByNodeId.get(cap.nodeId) || [];
    existing.push({
      type: cap.type,
      name: cap.name,
      version: cap.version,
      metadata: cap.metadata as Record<string, unknown> | undefined,
    });
    capabilitiesByNodeId.set(cap.nodeId, existing);
  }

  return nodesResult.map((node) => ({
    nodeId: node.nodeId,
    capabilities: capabilitiesByNodeId.get(node.nodeId) || [],
    addresses: node.addresses,
    metadata: node.metadata as Record<string, unknown> | undefined,
    reputation: (node as { reputation: number }).reputation,
    registeredAt: node.registeredAt.getTime(),
    lastSeen: node.lastSeen.getTime(),
    connectionId: '',
  }));
}

export async function getActiveNodes(timeoutMs: number): Promise<RegisteredNode[]> {
  const database = getDb();
  const cutoff = new Date(Date.now() - timeoutMs);

  const nodesResult = await database
    .select()
    .from(schema.nodes)
    .where(gt(schema.nodes.lastSeen, cutoff))
    .orderBy(desc(schema.nodes.lastSeen));

  const nodeIds = nodesResult.map((node) => node.nodeId);
  const capabilitiesResult = nodeIds.length > 0
    ? await database
        .select()
        .from(schema.capabilities)
        .where(inArray(schema.capabilities.nodeId, nodeIds))
    : [];

  const capabilitiesByNodeId = new Map<string, Capability[]>();
  for (const cap of capabilitiesResult) {
    const existing = capabilitiesByNodeId.get(cap.nodeId) || [];
    existing.push({
      type: cap.type,
      name: cap.name,
      version: cap.version,
      metadata: cap.metadata as Record<string, unknown> | undefined,
    });
    capabilitiesByNodeId.set(cap.nodeId, existing);
  }

  return nodesResult.map((node) => ({
    nodeId: node.nodeId,
    capabilities: capabilitiesByNodeId.get(node.nodeId) || [],
    addresses: node.addresses,
    metadata: node.metadata as Record<string, unknown> | undefined,
    reputation: (node as { reputation: number }).reputation,
    registeredAt: node.registeredAt.getTime(),
    lastSeen: node.lastSeen.getTime(),
    connectionId: '',
  }));
}

export async function deleteNode(nodeId: string): Promise<void> {
  const database = getDb();
  await database.delete(schema.nodes).where(eq(schema.nodes.nodeId, nodeId));
}

export async function markNodeInactive(nodeId: string): Promise<void> {
  const database = getDb();
  const inactiveDate = new Date(0);
  await database
    .update(schema.nodes)
    .set({ lastSeen: inactiveDate, updatedAt: new Date() })
    .where(eq(schema.nodes.nodeId, nodeId));
}

export async function findNodesByCapability(
  type?: string,
  name?: string,
  limit: number = 10
): Promise<RegisteredNode[]> {
  const database = getDb();
  const baseQuery = database
    .selectDistinct({ nodeId: schema.capabilities.nodeId })
    .from(schema.capabilities);

  let matchingNodeIds;
  if (type && name) {
    matchingNodeIds = await baseQuery
      .where(and(eq(schema.capabilities.type, type), eq(schema.capabilities.name, name)))
      .limit(limit);
  } else if (type) {
    matchingNodeIds = await baseQuery
      .where(eq(schema.capabilities.type, type))
      .limit(limit);
  } else {
    matchingNodeIds = await baseQuery.limit(limit);
  }
  const nodeIds = matchingNodeIds.map((r) => r.nodeId);

  if (nodeIds.length === 0) {
    return [];
  }

  const nodesResult = await database
    .select()
    .from(schema.nodes)
    .where(inArray(schema.nodes.nodeId, nodeIds));

  const capabilitiesResult = await database
    .select()
    .from(schema.capabilities)
    .where(inArray(schema.capabilities.nodeId, nodeIds));

  const capabilitiesByNodeId = new Map<string, Capability[]>();
  for (const cap of capabilitiesResult) {
    const existing = capabilitiesByNodeId.get(cap.nodeId) || [];
    existing.push({
      type: cap.type,
      name: cap.name,
      version: cap.version,
      metadata: cap.metadata as Record<string, unknown> | undefined,
    });
    capabilitiesByNodeId.set(cap.nodeId, existing);
  }

  return nodesResult.map((node) => ({
    nodeId: node.nodeId,
    capabilities: capabilitiesByNodeId.get(node.nodeId) || [],
    addresses: node.addresses,
    metadata: node.metadata as Record<string, unknown> | undefined,
    reputation: (node as { reputation: number }).reputation,
    registeredAt: node.registeredAt.getTime(),
    lastSeen: node.lastSeen.getTime(),
    connectionId: '',
  }));
}

export async function logEvent(
  eventType: string,
  nodeId: string,
  data: Record<string, unknown>
): Promise<void> {
  const database = getDb();
  await database.insert(schema.events).values({
    id: nanoid(),
    eventType,
    nodeId,
    data,
  });
}

export async function getRecentEvents(limit: number = 100): Promise<unknown[]> {
  const database = getDb();
  return await database.select().from(schema.events).orderBy(desc(schema.events.createdAt)).limit(limit);
}

export async function cleanupOldNodes(timeoutMs: number): Promise<number> {
  const database = getDb();
  const cutoff = new Date(Date.now() - timeoutMs);

  const result = await database.delete(schema.nodes).where(lt(schema.nodes.lastSeen, cutoff));

  return result.rowCount || 0;
}

export async function getStats(): Promise<{
  totalNodes: number;
  totalCapabilities: number;
  totalEvents: number;
}> {
  const database = getDb();
  const [nodesResult] = await database.select({ count: sql<number>`COUNT(*)::int` }).from(schema.nodes);

  const [capabilitiesResult] = await database
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(schema.capabilities);

  const [eventsResult] = await database.select({ count: sql<number>`COUNT(*)::int` }).from(schema.events);

  return {
    totalNodes: nodesResult.count,
    totalCapabilities: capabilitiesResult.count,
    totalEvents: eventsResult.count,
  };
}

export async function close(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
