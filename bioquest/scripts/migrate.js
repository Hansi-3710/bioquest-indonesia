import '../src/env.js';
import fs from 'node:fs';
import pg from 'pg';
import { SPECIES } from '../db/species.seed.js';

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) { console.error('MIGRATE_DATABASE_URL is not set. Run "npm run setup" first.'); process.exit(1); }
const client = new pg.Client({ connectionString: url, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
await client.connect();
try {
  await client.query(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  for (const [role, envName] of [['bioquest_app', 'APP_DB_PASSWORD'], ['bioquest_worker', 'WORKER_DB_PASSWORD']]) {
    const pw = process.env[envName];
    if (!pw) throw new Error(`${envName} is not set`);
    await client.query(`ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(pw)}`);
  }
  const db = (await client.query('SELECT current_database() AS d')).rows[0].d;
  await client.query(`GRANT CONNECT ON DATABASE ${client.escapeIdentifier(db)} TO bioquest_app, bioquest_worker`);
  await client.query('GRANT USAGE ON SCHEMA public TO bioquest_app, bioquest_worker');
  for (const s of SPECIES) {
    await client.query(
      `INSERT INTO species (slug, common_name, scientific_name, kind, iucn_code, status_label, description, habitat, why_it_matters, color_a, color_b, sensitive)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (slug) DO UPDATE SET common_name=EXCLUDED.common_name, scientific_name=EXCLUDED.scientific_name, kind=EXCLUDED.kind,
         iucn_code=EXCLUDED.iucn_code, status_label=EXCLUDED.status_label, description=EXCLUDED.description, habitat=EXCLUDED.habitat,
         why_it_matters=EXCLUDED.why_it_matters, color_a=EXCLUDED.color_a, color_b=EXCLUDED.color_b, sensitive=EXCLUDED.sensitive`,
      [s.slug, s.common, s.sci, s.kind, s.iucn, s.label, s.desc, s.habitat, s.why, s.a, s.b, s.sensitive]);
  }
  console.log(`Database ready: schema applied, ${SPECIES.length} species seeded, app roles configured.`);
} finally { await client.end(); }
