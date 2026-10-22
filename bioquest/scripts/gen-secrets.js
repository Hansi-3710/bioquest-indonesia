// Creates a .env with fresh random secrets. Refuses to overwrite an existing one.
import fs from 'node:fs';
import crypto from 'node:crypto';

const target = new URL('../.env', import.meta.url);
if (fs.existsSync(target)) { console.error('.env already exists. Delete it first if you really want new secrets (this makes existing data unreadable).'); process.exit(1); }
const hex = (n = 32) => crypto.randomBytes(n).toString('hex');
const appPw = hex(16), workerPw = hex(16), ownerPw = hex(16);
const env = `# Generated ${new Date().toISOString()}. NEVER commit this file. Back it up somewhere safe:
# losing these keys means encrypted photos, emails and locations can no longer be decrypted.
NODE_ENV=development
PORT=3000
PUBLIC_ORIGIN=http://localhost:3000

# Postgres. "owner" runs migrations; "app" and "worker" are least-privilege roles.
POSTGRES_PASSWORD=${ownerPw}
MIGRATE_DATABASE_URL=postgres://postgres:${ownerPw}@localhost:5432/bioquest
APP_DB_PASSWORD=${appPw}
WORKER_DB_PASSWORD=${workerPw}
DATABASE_URL=postgres://bioquest_app:${appPw}@localhost:5432/bioquest
WORKER_DATABASE_URL=postgres://bioquest_worker:${workerPw}@localhost:5432/bioquest

# 256-bit keys (64 hex chars each)
MEDIA_KEK_1=${hex()}
FIELD_ENCRYPTION_KEY=${hex()}
HMAC_KEY=${hex()}
PASSWORD_PEPPER=${hex()}

UPLOAD_DIR=./storage/vault
MODEL_DIR=./storage/models
`;
fs.writeFileSync(target, env, { mode: 0o600 });
console.log('Created .env (permissions 600). Keep it private and back it up.');
