import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { z } from 'zod';
import { NodeRegistrationSchema, PingSchema, WebSocketMessageSchema } from './types';
import * as database from './database';
import * as cache from './cache';
import * as metrics from './metrics';
import type { RegistryStats, WebSocketMessage } from './types';
import { logger } from './logger';
import { nanoid } from 'nanoid';

const app = new Hono();

let startTime = Date.now();

app.get('/health', (c) => {
  return c.json({
    status: 'healthy' as const,
    uptime: Date.now() - startTime,
    timestamp: Date.now(),
  });
});

app.get('/metrics', async (c) => {
  const metricsText = metrics.getMetrics();
  return c.text(metricsText);
});

app.get('/api/nodes', async (c) => {
  try {
    const activeOnly = c.req.query('active') === 'true';
    const nodes = activeOnly ? await database.getActiveNodes(60000) : await database.getAllNodes();

    return c.json({
      success: true,
      data: {
        nodes,
        count: nodes.length,
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error({ error }, 'Error getting all nodes');
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      },
      500
    );
  }
});

app.get('/api/nodes/:nodeId', async (c) => {
  try {
    const nodeId = c.req.param('nodeId');
    let node = await cache.getNode(nodeId);

    if (!node) {
      node = await database.getNode(nodeId);
    }

    if (!node) {
      return c.json(
        {
          success: false,
          error: 'Node not found',
          timestamp: Date.now(),
        },
        404
      );
    }

    return c.json({
      success: true,
      data: node,
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error({ error }, 'Error getting node');
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      },
      500
    );
  }
});

app.post('/api/register', async (c) => {
  try {
    const raw = await c.req.json();
    const parsed = NodeRegistrationSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: 'Invalid request body',
          timestamp: Date.now(),
        },
        400
      );
    }
    const body = parsed.data;
    const existingNode = await database.getNode(body.nodeId);
    const isReconnecting = existingNode !== null;
    const wasInactive = existingNode !== null && existingNode.lastSeen === 0;
    
    const now = Date.now();
    const node = {
      nodeId: body.nodeId,
      capabilities: body.capabilities.map((c) => ({
        type: c.type,
        name: c.name,
        version: c.version,
        metadata: c.metadata,
      })),
      addresses: body.addresses,
      metadata: body.metadata,
      reputation: existingNode?.reputation || 0,
      registeredAt: existingNode?.registeredAt || now,
      lastSeen: now,
      connectionId: 'http',
    };

    await database.saveNode(node);
    await cache.cacheNode(node);
    const eventType = wasInactive ? 'reconnect' : isReconnecting ? 'reactivate' : 'register';
    await database.logEvent(eventType, body.nodeId, {});

    const responseMessage = wasInactive ? 'Reconnected and reactivated' : isReconnecting ? 'Reactivated existing node' : 'Registered';
    return c.json({
      success: true,
      data: { message: responseMessage },
      timestamp: Date.now(),
    });
    } catch (error) {
      logger.error({ error }, 'Error registering node');
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
        500
      );
    }
  }
);

app.post('/api/unregister', async (c) => {
  try {
    const raw = await c.req.json();
    const parsed = z.object({ nodeId: z.string() }).safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: 'Invalid request body',
          timestamp: Date.now(),
        },
        400
      );
    }
    const body = parsed.data;
    await cache.removeNode(body.nodeId);
    await database.markNodeInactive(body.nodeId);
    await database.logEvent('unregister', body.nodeId, {});

    return c.json({
      success: true,
      data: { message: 'Marked as inactive' },
      timestamp: Date.now(),
    });
    } catch (error) {
      logger.error({ error }, 'Error unregistering node');
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
        500
      );
    }
  }
);

app.post('/api/ping', async (c) => {
  try {
    const raw = await c.req.json();
    const parsed = PingSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: 'Invalid request body',
          timestamp: Date.now(),
        },
        400
      );
    }
    const body = parsed.data;
    await database.updateNodeLastSeen(body.nodeId);
    const node = await database.getNode(body.nodeId);
    if (node) {
      await cache.cacheNode(node);
    }

    return c.json({
      success: true,
      data: { message: 'Pong' },
      timestamp: Date.now(),
    });
    } catch (error) {
      logger.error({ error }, 'Error pinging node');
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
        500
      );
    }
  }
);

app.post('/api/nodes/:nodeId/reputation', async (c) => {
  try {
    const nodeId = c.req.param('nodeId');
    const raw = await c.req.json();
    const parsed = z.object({ value: z.number() }).safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: 'Invalid request body',
          timestamp: Date.now(),
        },
        400
      );
    }
    const body = parsed.data;
    const node = await database.getNode(nodeId);

    if (!node) {
      return c.json(
        {
          success: false,
          error: 'Node not found',
          timestamp: Date.now(),
        },
        404
      );
    }

    const timeoutMs = 60000;
    if (node.lastSeen < Date.now() - timeoutMs) {
      return c.json(
        {
          success: false,
          error: 'Node not active',
          timestamp: Date.now(),
        },
        400
      );
    }

    await database.updateNodeReputation(nodeId, body.value);
    const updated = await database.getNode(nodeId);
    if (updated) {
      await cache.cacheNode(updated);
    }
    await database.logEvent('reputation_update', nodeId, { value: body.value });

    return c.json({
      success: true,
      data: { message: 'Reputation updated' },
      timestamp: Date.now(),
    });
    } catch (error) {
      logger.error({ error }, 'Error updating reputation');
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
        500
      );
    }
  }
);

app.get('/api/capabilities/search', async (c) => {
  try {
    const type = c.req.query('type') || undefined;
    const name = c.req.query('name') || undefined;
    const limit = Math.min(parseInt(c.req.query('limit') || '10'), 100);

    const nodes = await database.findNodesByCapability(type, name, limit);

    return c.json({
      success: true,
      data: {
        nodes,
        count: nodes.length,
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error({ error }, 'Error searching capabilities');
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      },
      500
    );
  }
});

app.get('/api/stats', async (c) => {
  try {
    const dbStats = await database.getStats();
    const activeNodes = await database.getActiveNodes(60000);

    const stats: RegistryStats = {
      totalNodes: dbStats.totalNodes,
      activeNodes: activeNodes.length,
      totalCapabilities: dbStats.totalCapabilities,
      uptime: Date.now() - startTime,
      messagesProcessed: await cache.getCounter('messages_processed'),
      averageLatency: (await cache.getMetric('avg_latency')) || 0,
    };

    return c.json({
      success: true,
      data: stats,
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error({ error }, 'Error getting stats');
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      },
      500
    );
  }
});

app.get('/api/events', async (c) => {
  try {
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 1000);
    const events = await database.getRecentEvents(limit);

    return c.json({
      success: true,
      data: {
        events,
        count: events.length,
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error({ error }, 'Error getting events');
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      },
      500
    );
  }
});

app.post('/api/admin/cache/flush', async (c) => {
  try {
    await cache.flushAll();

    return c.json({
      success: true,
      data: { message: 'Cache flushed successfully' },
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error({ error }, 'Error flushing cache');
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      },
      500
    );
  }
});

interface WebSocketLike {
  send(data: string): void;
}

const activeConnections = new Map<string, { nodeId?: string }>();

function sendMessage(ws: WebSocketLike, type: string, payload: unknown, id?: string): void {
  const message = {
    id: id || nanoid(),
    type,
    payload,
    timestamp: Date.now(),
  };
  ws.send(JSON.stringify(message));
}

function sendError(ws: WebSocketLike, error: string, id?: string): void {
  sendMessage(ws, 'error', { success: false, error }, id);
}

function sendResponse(ws: WebSocketLike, data: unknown, id: string): void {
  sendMessage(ws, 'response', { success: true, data }, id);
}

app.get('/ws', upgradeWebSocket((c) => {
  const connectionId = nanoid();
  
  return {
    onOpen(event, ws) {
      activeConnections.set(connectionId, {});
      sendMessage(ws, 'welcome', { message: 'Connected to Ecco Registry' });
      logger.info({ connectionId }, 'WebSocket client connected');
    },
    
    onMessage(event, ws) {
      try {
        const data = typeof event.data === 'string' ? event.data : event.data.toString();
        const parsed = WebSocketMessageSchema.safeParse(JSON.parse(data));
        
        if (!parsed.success) {
          sendError(ws, 'Invalid message format');
          return;
        }
        
        const message = parsed.data;
        handleWebSocketMessage(ws, message, connectionId);
      } catch (error) {
        logger.error({ error, connectionId }, 'Error handling WebSocket message');
        sendError(ws, error instanceof Error ? error.message : 'Unknown error');
      }
    },
    
    onClose(event, ws) {
      const conn = activeConnections.get(connectionId);
      if (conn?.nodeId) {
        logger.info({ nodeId: conn.nodeId, connectionId }, 'WebSocket client disconnected');
      }
      activeConnections.delete(connectionId);
    },
    
    onError(event, ws) {
      logger.error({ connectionId, error: event }, 'WebSocket error');
      activeConnections.delete(connectionId);
    },
  };
}));

async function handleWebSocketMessage(ws: WebSocketLike, message: WebSocketMessage, connectionId: string): Promise<void> {
  const conn = activeConnections.get(connectionId);
  if (!conn) {
    sendError(ws, 'Connection not found', message.id);
    return;
  }
  
  switch (message.type) {
    case 'register': {
      const payload = message.payload as { nodeId: string; capabilities: unknown[]; addresses: string[] };
      const parsed = NodeRegistrationSchema.safeParse(payload);
      
      if (!parsed.success) {
        sendError(ws, 'Invalid registration data', message.id);
        return;
      }
      
      const body = parsed.data;
      const existingNode = await database.getNode(body.nodeId);
      const isReconnecting = existingNode !== null;
      const wasInactive = existingNode !== null && existingNode.lastSeen === 0;
      
      const now = Date.now();
      const node = {
        nodeId: body.nodeId,
        capabilities: body.capabilities.map((c) => ({
          type: c.type,
          name: c.name,
          version: c.version,
          metadata: c.metadata,
        })),
        addresses: body.addresses,
        metadata: body.metadata,
        reputation: existingNode?.reputation || 0,
        registeredAt: existingNode?.registeredAt || now,
        lastSeen: now,
        connectionId,
      };
      
      await database.saveNode(node);
      await cache.cacheNode(node);
      const eventType = wasInactive ? 'reconnect' : isReconnecting ? 'reactivate' : 'register';
      await database.logEvent(eventType, body.nodeId, {});
      
      conn.nodeId = body.nodeId;
      activeConnections.set(connectionId, conn);
      
      const responseMessage = wasInactive ? 'Reconnected and reactivated' : isReconnecting ? 'Reactivated existing node' : 'Registered';
      sendResponse(ws, { message: responseMessage }, message.id);
      const logMessage = wasInactive ? 'Node reconnected via WebSocket' : isReconnecting ? 'Node reactivated via WebSocket' : 'Node registered via WebSocket';
      logger.info({ nodeId: body.nodeId, connectionId, isReconnecting, wasInactive }, logMessage);
      break;
    }
    
    case 'unregister': {
      const payload = message.payload as { nodeId: string };
      const nodeId = payload.nodeId || conn.nodeId;
      
      if (!nodeId) {
        sendError(ws, 'Node ID required', message.id);
        return;
      }
      
      await cache.removeNode(nodeId);
      await database.markNodeInactive(nodeId);
      await database.logEvent('unregister', nodeId, {});
      
      conn.nodeId = undefined;
      activeConnections.set(connectionId, conn);
      
      sendResponse(ws, { message: 'Marked as inactive' }, message.id);
      logger.info({ nodeId, connectionId }, 'Node marked as inactive via WebSocket');
      break;
    }
    
    case 'query': {
      const payload = message.payload as { requiredCapabilities?: Array<{ type?: string; name?: string; version?: string }> };
      const firstCapability = payload.requiredCapabilities?.[0];
      const type = firstCapability?.type;
      const name = firstCapability?.name;
      const limit = 10;
      
      const nodes = await database.findNodesByCapability(type, name, limit);
      
      sendResponse(ws, { nodes, count: nodes.length }, message.id);
      break;
    }
    
    case 'ping': {
      const payload = message.payload as { nodeId: string; timestamp: number };
      const parsed = PingSchema.safeParse(payload);
      
      if (!parsed.success) {
        sendError(ws, 'Invalid ping data', message.id);
        return;
      }
      
      const body = parsed.data;
      await database.updateNodeLastSeen(body.nodeId);
      const node = await database.getNode(body.nodeId);
      if (node) {
        await cache.cacheNode(node);
      }
      
      sendMessage(ws, 'pong', { timestamp: Date.now() }, message.id);
      break;
    }
    
    default:
      sendError(ws, `Unknown message type: ${message.type}`, message.id);
  }
}

export { app, websocket };
