// Researcher accounts can NOT be created from the website. An administrator with
// server access runs this script. Two-factor is set up by the researcher at first sign-in.
//
//   npm run create-researcher -- --email dr.sari@univ.ac.id --name "Dr. Sari"
//   npm run create-researcher -- --reset-mfa --email dr.sari@univ.ac.id
import '../src/env.js';
import crypto from 'node:crypto';
import pg from 'pg';
import { hashPassword } from '../src/security/password.js';
import { encryptField, emailBlindIndex } from '../src/security/crypto.js';

const args = process.argv.slice(2);
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const email = get('--email')?.trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('Usage: --email <address> --name "<display name>" [--reset-mfa]'); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await client.connect();
try {
  if (args.includes('--reset-mfa')) {
    const r = await client.query(`UPDATE users SET mfa_enabled=false, mfa_secret_enc=NULL, mfa_last_step=0 WHERE email_hash=$1 AND role='researcher'`, [emailBlindIndex(email)]);
    await client.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email_hash=$1)`, [emailBlindIndex(email)]);
    console.log(r.rowCount ? 'Two-factor reset. They will set it up again at next sign-in.' : 'No researcher with that email.');
  } else {
    const name = get('--name') || 'Researcher';
    // One-time password, shown once; the researcher is asked to change it after first sign-in.
    const temp = crypto.randomBytes(15).toString('base64url');
    const r = await client.query(
      `INSERT INTO users (email_enc, email_hash, display_name, password_hash, role, onboarded)
       VALUES ($1,$2,$3,$4,'researcher',true) ON CONFLICT (email_hash) DO NOTHING RETURNING id`,
      [encryptField(email, 'users.email'), emailBlindIndex(email), name.slice(0, 30), await hashPassword(temp)]);
    if (!r.rowCount) console.log('A user with that email already exists.');
    else console.log(`Researcher created.\n  Email:        ${email}\n  Temp password: ${temp}\n\nSign in at /research, set up two-factor, then change the password.`);
  }
} finally { await client.end(); }
