#!/usr/bin/env bun

import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let configDir = resolve(__dirname, '..');
let configPath = resolve(configDir, 'drizzle.config.ts');

if (!existsSync(configPath)) {
  const nodeModulesPath = resolve(process.cwd(), 'node_modules/@ecco/core/drizzle.config.ts');
  if (existsSync(nodeModulesPath)) {
    configPath = nodeModulesPath;
    configDir = resolve(nodeModulesPath, '..');
  }
}

const eccoDir = resolve(homedir(), '.ecco');
const dbPathEnv = process.env.ECCO_DB_PATH || 'default.sqlite';
const dbPath = dbPathEnv.startsWith('/')
  ? dbPathEnv
  : resolve(eccoDir, dbPathEnv);
const dbDir = dirname(dbPath);

if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

const env = {
  ...process.env,
  ECCO_DB_PATH: dbPath,
};

try {
  execSync(`bunx drizzle-kit push --config ${configPath}`, {
    stdio: 'inherit',
    cwd: configDir,
    env,
  });
} catch (error) {
  process.exit(1);
}

