import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run queries: the db itself or a transaction. */
export type Executor = Db | Tx;

export type DbHandle = { db: Db; pool: Pool; close: () => Promise<void> };

export function createDbHandle(connectionString: string, config: PoolConfig = {}): DbHandle {
  const pool = new Pool({ connectionString, max: 20, ...config });
  // an idle client error must not crash the process
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

/** PostgreSQL error code helper (23505 = unique_violation, 23514 = check_violation, ...). */
export function pgErrorCode(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null) {
    const direct = (e as { code?: unknown }).code;
    if (typeof direct === 'string') return direct;
    // drizzle wraps driver errors and keeps the original in `cause`
    const cause = (e as { cause?: unknown }).cause;
    if (typeof cause === 'object' && cause !== null) {
      const c = (cause as { code?: unknown }).code;
      if (typeof c === 'string') return c;
    }
  }
  return undefined;
}

export function pgConstraint(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null) {
    const direct = (e as { constraint?: unknown }).constraint;
    if (typeof direct === 'string') return direct;
    const cause = (e as { cause?: unknown }).cause;
    if (typeof cause === 'object' && cause !== null) {
      const c = (cause as { constraint?: unknown }).constraint;
      if (typeof c === 'string') return c;
    }
  }
  return undefined;
}
