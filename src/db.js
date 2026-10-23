
import pg from 'pg';
import { config } from './config.js';

// Return BIGINT/NUMERIC-free types as JS numbers where safe.
pg.types.setTypeParser(20, (v) => Number(v)); // int8

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  statement_timeout: 15_000,
  ssl: { rejectUnauthorized: false }
});

/** Run `fn(client)` in a transaction with the caller's identity attached, so
 *  Postgres Row-Level Security policies apply to every query inside. */
export async function withIdentity(identity, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true)`,
      [identity?.id ?? '', identity?.role ?? 'anon']
    );
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export const query = (text, params) => pool.query(text, params);
