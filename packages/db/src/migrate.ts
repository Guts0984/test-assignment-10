import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { type Db } from './client';

/** `dist/migrate.js` and `src/migrate.ts` both sit one level below the package root. */
export const MIGRATIONS_FOLDER = path.resolve(__dirname, '..', 'migrations');

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
