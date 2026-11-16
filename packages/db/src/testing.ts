import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createDbHandle, type DbHandle } from './client';
import { runMigrations } from './migrate';

export const DEFAULT_TEST_DATABASE_URL = 'postgres://shop:shop_dev_password@localhost:5433/shop';

export type TestDatabase = DbHandle & { url: string; name: string; drop: () => Promise<void> };

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/**
 * Creates a brand-new, migrated PostgreSQL database for one test file and returns a handle.
 * Tests therefore never share state and can run in parallel against a real server.
 */
export async function createTestDatabase(opts: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const name = `t_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(adminUrl, name);
  const handle = createDbHandle(url);
  if (opts.migrate !== false) await runMigrations(handle.db);
  return {
    ...handle,
    url,
    name,
    drop: async () => {
      await handle.close();
      const a = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}
