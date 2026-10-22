// Key rotation: add MEDIA_KEK_2=<new 64-hex> to .env, run this, then you may retire KEK 1.
// Only the small wrapped data keys are re-encrypted; the photo/video files are untouched.
import '../src/env.js';
import pg from 'pg';
import { config } from '../src/config.js';
import { wrapKey, unwrapKey } from '../src/security/crypto.js';

const target = config.keys.currentKek;
const client = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('ALTER TABLE media NO FORCE ROW LEVEL SECURITY'); // owner-only maintenance window
  const { rows } = await client.query('SELECT id, dek_wrapped, thumb_dek_wrapped, kek_version FROM media WHERE kek_version <> $1', [target]);
  for (const r of rows) {
    const dek = unwrapKey(r.dek_wrapped, r.kek_version);
    const tdek = r.thumb_dek_wrapped ? unwrapKey(r.thumb_dek_wrapped, r.kek_version) : null;
    await client.query('UPDATE media SET dek_wrapped=$2, thumb_dek_wrapped=$3, kek_version=$4 WHERE id=$1',
      [r.id, wrapKey(dek, target), tdek ? wrapKey(tdek, target) : null, target]);
  }
  await client.query('ALTER TABLE media FORCE ROW LEVEL SECURITY');
  await client.query('COMMIT');
  console.log(`Re-wrapped ${rows.length} file keys to KEK v${target}.`);
} catch (e) { await client.query('ROLLBACK'); console.error('Rotation failed, nothing changed:', e.message); process.exit(1); }
finally { await client.end(); }
