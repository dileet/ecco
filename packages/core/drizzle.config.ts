import { defineConfig } from 'drizzle-kit';
import { resolve } from 'path';

const dbPath = process.env.ECCO_DB_PATH 
  ? (process.env.ECCO_DB_PATH.startsWith('/') 
      ? process.env.ECCO_DB_PATH 
      : resolve(process.cwd(), process.env.ECCO_DB_PATH))
  : resolve(process.cwd(), '.ecco', 'default.sqlite');

export default defineConfig({
  schema: './src/storage/schema.ts',
  out: './.ecco/drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: dbPath,
  },
});


