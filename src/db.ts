import pg from 'pg';
import { attachDatabasePool } from '@vercel/functions';

export interface Database {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Store extends Database {
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
}
let pool: pg.Pool | undefined;
export function getStore(): Store {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3,
      connectionTimeoutMillis: 10_000, idleTimeoutMillis: 5_000 });
    attachDatabasePool(pool);
    pool.on('error', () => console.error('Database pool error'));
  }
  const p = pool;
  return {
    query: (sql, values) => p.query(sql, values),
    async transaction(fn) {
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout = '12000'");
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
  };
}
export async function closeStore() { await pool?.end(); pool = undefined; }
