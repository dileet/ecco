import Redis from 'ioredis';
import type { RegisteredNode } from './types';
import { logger } from './logger';

const PREFIX = 'ecco:';

const key = (suffix: string): string => `${PREFIX}${suffix}`;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379');
    const password = process.env.REDIS_PASSWORD;
    const db = parseInt( process.env.REDIS_DB || '0');

    redis = new Redis({
      host,
      port,
      password,
      db,
      retryStrategy: () => null,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
    });

    redis.on('connect', () => {
      logger.info('Redis connected');
    });

    redis.on('ready', () => {
      logger.info('Redis ready');
    });

    redis.on('close', () => {
      logger.info('Redis connection closed');
    });

    redis.on('error', (error) => {
      logger.error({ error: error.message }, 'Redis connection error');
    });
  }
  return redis;
}

export async function initialize(): Promise<void> {
  const client = getRedis();
  await client.connect();
}

export async function cacheNode(node: RegisteredNode): Promise<void> {
  const client = getRedis();
  await Promise.all([
    client.setex(key(`node:${node.nodeId}`), 3600, JSON.stringify(node)),
    client.zadd(key('nodes:active'), node.lastSeen, node.nodeId),
    ...node.capabilities.map(async (capability) => {
      const capKey = key(`cap:${capability.type}:${capability.name}`);
      await client.sadd(capKey, node.nodeId);
      await client.expire(capKey, 3600);
    }),
  ]);
}

export async function getNode(nodeId: string): Promise<RegisteredNode | null> {
  const client = getRedis();
  const data = await client.get(key(`node:${nodeId}`));
  if (!data) return null;
  try {
    return JSON.parse(data) as RegisteredNode;
  } catch {
    return null;
  }
}

export async function removeNode(nodeId: string): Promise<void> {
  const client = getRedis();
  const node = await getNode(nodeId);

  if (node) {
    await Promise.all([
      ...node.capabilities.map((capability) => {
        const capKey = key(`cap:${capability.type}:${capability.name}`);
        return client.srem(capKey, nodeId);
      }),
      client.del(key(`node:${nodeId}`)),
      client.zrem(key('nodes:active'), nodeId),
    ]);
  }
}

export async function getActiveNodeIds(limit: number = 100): Promise<string[]> {
  const client = getRedis();
  return await client.zrevrange(key('nodes:active'), 0, limit - 1);
}

export async function findNodeIdsByCapability(type: string, name?: string): Promise<string[]> {
  const client = getRedis();
  const pattern = name ? key(`cap:${type}:${name}`) : key(`cap:${type}:*`);

  if (name) {
    return await client.smembers(pattern);
  }

  const keys = await client.keys(pattern);
  const nodeIdsSet = new Set<string>();

  for (const k of keys) {
    const members = await client.smembers(k);
    members.forEach((id) => nodeIdsSet.add(id));
  }

  return Array.from(nodeIdsSet);
}

export async function checkRateLimit(
  identifier: string,
  maxRequests: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const client = getRedis();
  const rateLimitKey = key(`ratelimit:${identifier}`);
  const now = Date.now();
  const windowStart = now - windowMs;

  await client.zremrangebyscore(rateLimitKey, '-inf', windowStart);

  const count = await client.zcard(rateLimitKey);

  if (count >= maxRequests) {
    const oldestEntry = await client.zrange(rateLimitKey, 0, 0, 'WITHSCORES');
    const resetAt = oldestEntry.length > 1 ? parseInt(oldestEntry[1]) + windowMs : now + windowMs;

    return {
      allowed: false,
      remaining: 0,
      resetAt,
    };
  }

  await client
    .zadd(rateLimitKey, now, `${now}-${Math.random()}`)
    .then(() => client.expire(rateLimitKey, Math.ceil(windowMs / 1000)));

  return {
    allowed: true,
    remaining: maxRequests - count - 1,
    resetAt: now + windowMs,
  };
}

export async function incrementCounter(name: string): Promise<number> {
  const client = getRedis();
  return await client.incr(key(`counter:${name}`));
}

export async function getCounter(name: string): Promise<number> {
  const client = getRedis();
  const value = await client.get(key(`counter:${name}`));
  return value ? parseInt(value) : 0;
}

export async function setMetric(name: string, value: number, ttl: number = 3600): Promise<void> {
  const client = getRedis();
  await client.setex(key(`metric:${name}`), ttl, value.toString());
}

export async function getMetric(name: string): Promise<number | null> {
  const client = getRedis();
  const value = await client.get(key(`metric:${name}`));
  return value ? parseFloat(value) : null;
}

export async function publish(channel: string, message: unknown): Promise<void> {
  const client = getRedis();
  await client.publish(key(`channel:${channel}`), JSON.stringify(message));
}

export async function flushAll(): Promise<void> {
  const client = getRedis();
  const keys = await client.keys(key('*'));
  if (keys.length > 0) {
    await client.del(...keys);
  }
}

export async function close(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
