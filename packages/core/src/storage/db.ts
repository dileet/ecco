import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';

let dbInstance: ReturnType<typeof drizzle> | null = null;
let sqliteDb: Database | null = null;
let currentNodeId: string | null = null;
let dbNodeId: string | null = null;
let initPromise: Promise<void> | null = null;

const getEccoDir = (): string => path.resolve(homedir(), '.ecco');
const getDbPath = (nodeId: string): string => path.join(getEccoDir(), `${nodeId}.sqlite`);
const isDbReady = (nodeId: string): boolean => dbInstance !== null && dbNodeId === nodeId;

export const isNoSuchTableError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('no such table');

export const getDb = (): ReturnType<typeof drizzle> | null => dbInstance;

export const requireDb = (): ReturnType<typeof drizzle> => {
  if (!dbInstance) throw new Error('Database not initialized');
  return dbInstance;
};

export const runTransaction = <T>(operation: () => T): T => {
  if (!sqliteDb) throw new Error('Database not initialized');
  sqliteDb.run('BEGIN IMMEDIATE');
  try {
    const result = operation();
    sqliteDb.run('COMMIT');
    return result;
  } catch (error) {
    sqliteDb.run('ROLLBACK');
    throw error;
  }
};

const openDatabase = (nodeId: string, createIfMissing: boolean): void => {
  const dbPath = getDbPath(nodeId);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!createIfMissing && !fs.existsSync(dbPath)) return;
  sqliteDb = new Database(dbPath);
  dbInstance = drizzle({ client: sqliteDb });
  dbNodeId = nodeId;
};

const initializeDatabase = async (nodeId: string, createIfMissing: boolean): Promise<void> => {
  if (isDbReady(nodeId)) return;
  if (initPromise) {
    await initPromise;
    if (isDbReady(nodeId)) return;
  }
  initPromise = Promise.resolve().then(() => {
    if (!isDbReady(nodeId)) openDatabase(nodeId, createIfMissing);
  });
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
};

export const ensureDbInitialized = async (): Promise<void> => {
  if (!currentNodeId) throw new Error('Node ID not set');
  await initializeDatabase(currentNodeId, true);
};

export const initialize = async (nodeId: string): Promise<void> => {
  currentNodeId = nodeId;
  await initializeDatabase(nodeId, false);
};

export const close = (): void => {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
  dbInstance = null;
  currentNodeId = null;
  dbNodeId = null;
  initPromise = null;
};

export const handleLoadError = (error: unknown, label: string): never => {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`Failed to load ${label}: ${message}`);
};
