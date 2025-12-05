import { defineConfig } from 'drizzle-kit';
import { resolve } from 'path';
import { homedir } from 'os';

const eccoDir = resolve(homedir(), '.ecco');
const dbPath = process.env.ECCO_DB_PATH
  ? (process.env.ECCO_DB_PATH.startsWith('/')
      ? process.env.ECCO_DB_PATH
      : resolve(eccoDir, process.env.ECCO_DB_PATH))
  : resolve(eccoDir, 'default.sqlite');

export default defineConfig({
  schema: './src/storage/schema.ts',
  out: resolve(eccoDir, 'drizzle'),
  dialect: 'sqlite',
  dbCredentials: {
    url: dbPath,
  },
});


