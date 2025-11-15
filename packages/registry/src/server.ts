#!/usr/bin/env bun

import { app, websocket } from './http-server';
import * as database from './database';
import * as cache from './cache';
import { logger } from './logger';

const port = parseInt(process.env.HTTP_PORT || '8081');

async function main() {
  try {
    logger.info('Starting Ecco Registry Server...');

    await database.initialize();
    await cache.initialize();

    Bun.serve({
      fetch: app.fetch,
      websocket,
      port,
    });

    logger.info('Ecco Registry Server started successfully', {
      httpPort: port,
    });

    process.on('SIGINT', async () => {
      logger.info('Shutting down...');
      await database.close();
      await cache.close();
      process.exit(0);
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

main();
