// ============================================================================
// Database access. One connection pool for the whole process.
// ============================================================================
import pg from 'pg';

// --- BIGINT handling -------------------------------------------------------
// By default node-postgres returns BIGINT (type oid 20) as a *string*, because
// a 64-bit integer does not always fit in a JavaScript number. Every amount in
// this project is paise, and JavaScript integers are exact up to 2^53 - about
// 90 trillion rupees - so converting to a number here is safe and saves us
// from writing Number(...) at every call site.
pg.types.setTypeParser(20, (value) => parseInt(value, 10));

// Next.js hot-reloads modules in development, which would create a new pool on
// every save and eventually exhaust Postgres connections. Stashing the pool on
// globalThis keeps exactly one alive across reloads.
const globalForPool = globalThis;

export const pool =
  globalForPool.__fluxPool ??
  (globalForPool.__fluxPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,

    // The benchmark fires 200 transfers at once. This number is the real limit
    // on how many of them are genuinely concurrent inside Postgres - the rest
    // queue here in the client. It is deliberately well below Postgres
    // default max_connections (100) so the app and the benchmark can coexist.
    max: Number(process.env.DB_POOL_MAX ?? 40),

    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  }));

/**
 * Run a single query on a pooled connection.
 * Use this for reads and for anything that does not need a transaction.
 */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Check out a connection, hand it to `fn`, and always give it back.
 *
 * Every transfer strategy needs this: a transaction has to run all of its
 * statements on the *same* connection, so we cannot use pool.query() directly.
 */
export async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on any
 * thrown error.
 *
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 * @param {{ isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' }} [options]
 */
export async function withTransaction(fn, options = {}) {
  const { isolationLevel = 'READ COMMITTED' } = options;

  return withClient(async (client) => {
    await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // ROLLBACK can itself fail if the connection died mid-transaction. We
      // swallow that so the *original* error is the one the caller sees -
      // otherwise a useful "insufficient funds" becomes a confusing socket
      // error.
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

/** Close the pool. Scripts call this so the process can exit. */
export function closePool() {
  return pool.end();
}
