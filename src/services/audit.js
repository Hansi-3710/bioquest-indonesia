import crypto from 'node:crypto';
import { pool } from '../db.js';
import { config } from '../config.js';
import { hashMeta } from '../security/crypto.js';

const ZERO = Buffer.alloc(32);

// Deterministic JSON so the same row always hashes the same way.
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

export function rowHash(prev, { at, actor_id, action, target, ip_hash, meta }) {
  const body = canonical({ at: new Date(at).toISOString(), actor_id, action, target, ip_hash: ip_hash ? ip_hash.toString('hex') : null, meta });
  return crypto.createHmac('sha256', config.keys.hmac).update(prev).update(body).digest();
}

/** Append an audit event. Never throws into the request path; failures are logged. */
export async function audit(req, action, { actorId, target = null, meta = {} } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7001)');
    const last = await client.query('SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prev = last.rows[0]?.row_hash ?? ZERO;
    const row = {
      at: new Date(), actor_id: actorId ?? req?.auth?.user?.id ?? null, action, target,
      ip_hash: hashMeta(req?.ip), meta
    };
    const h = rowHash(prev, row);
    await client.query(
      `INSERT INTO audit_log (at, actor_id, action, target, ip_hash, meta, prev_hash, row_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.at, row.actor_id, row.action, row.target, row.ip_hash, row.meta, prev, h]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(JSON.stringify({ level: 'error', msg: 'audit_write_failed', action, err: e.message }));
  } finally {
    client.release();
  }
}

export async function verifyChain(db = pool) {
  const { rows } = await db.query('SELECT * FROM audit_log ORDER BY id');
  let prev = ZERO;
  for (const r of rows) {
    if (!r.prev_hash.equals(prev)) return { ok: false, brokenAt: r.id, rows: rows.length };
    const h = rowHash(prev, r);
    if (!h.equals(r.row_hash)) return { ok: false, brokenAt: r.id, rows: rows.length };
    prev = r.row_hash;
  }
  return { ok: true, rows: rows.length };
}
