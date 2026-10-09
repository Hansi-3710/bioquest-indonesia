// Verifies the tamper-evident hash chain of the audit log.
import '../src/env.js';
import pg from 'pg';
import { verifyChain } from '../src/services/audit.js';

const client = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await client.connect();
const r = await verifyChain(client);
await client.end();
if (r.ok) console.log(`Audit log intact: ${r.rows} entries verified.`);
else { console.error(`AUDIT LOG TAMPERING DETECTED at entry #${r.brokenAt}.`); process.exit(2); }
