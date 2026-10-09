// End-to-end security + feature tests. Needs a migrated database (see README).
import '../src/env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { generateSync } from 'otplib';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { hashPassword } from '../src/security/password.js';
import { encryptField, emailBlindIndex, decryptField } from '../src/security/crypto.js';
import { verifyChain } from '../src/services/audit.js';

let server, base, owner;
const tag = Date.now().toString(36);

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async call(method, url, body, extra = {}) {
    const headers = { ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}), ...extra.headers };
    let payload = body;
    if (body && !(body instanceof FormData)) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) { const [kv] = c.split(';'); if (kv.endsWith('=')) this.cookie = ''; else this.cookie = kv; }
    const ct = res.headers.get('content-type') ?? '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    if (data?.csrfToken) this.csrf = data.csrfToken;
    return { status: res.status, data, headers: res.headers };
  }
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  owner = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
  await owner.connect();
});
after(async () => { server.close(); await owner.end(); await pool.end(); });

const pw = 'correct horse battery staple';
const photo = () => sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 30, g: 140, b: 70 } } }).jpeg().toBuffer();
const uploadForm = async (extra = {}) => {
  const fd = new FormData();
  fd.append('files', new Blob([await photo()], { type: 'image/jpeg' }), 'leaf.jpg');
  fd.append('lat', '-6.9'); fd.append('lon', '107.6'); fd.append('placeLabel', 'Bandung'); fd.append('notes', 'secret note');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
};

test('security headers are strict', async () => {
  const r = await new Client().call('GET', '/');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp.match(/script-src [^;]*/)[0], /unsafe-inline/, 'no inline scripts');
  assert.doesNotMatch(csp.match(/style-src [^;]*/)[0], /unsafe-inline/, 'no inline <style> blocks');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('registration enforces password policy and sets a hardened cookie', async () => {
  const c = new Client();
  const weak = await c.call('POST', '/api/auth/register', { email: `a${tag}@t.io`, password: 'short', displayName: 'Ayu', acceptTerms: true });
  assert.equal(weak.status, 400);
  const ok = await c.call('POST', '/api/auth/register', { email: `a${tag}@t.io`, password: pw, displayName: 'Ayu', acceptTerms: true, consentResearch: true });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.user.role, 'user');
  const raw = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `a${tag}@t.io`, password: pw }) });
  const cookie = raw.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Strict/i);
});

test('email and password are not stored in readable form', async () => {
  const { rows: [u] } = await owner.query('SELECT * FROM users WHERE email_hash = $1', [emailBlindIndex(`a${tag}@t.io`)]);
  assert.ok(u.password_hash.startsWith('$argon2id$'));
  assert.ok(!u.email_enc.toString('utf8').includes('@t.io'));
  assert.equal(decryptField(u.email_enc, 'users.email'), `a${tag}@t.io`);
  assert.throws(() => decryptField(u.email_enc, 'observations.notes'), 'ciphertext is bound to its column');
});

test('login errors are generic, lockout works, CSRF is enforced', async () => {
  const c = new Client();
  const bad = await c.call('POST', '/api/auth/login', { email: `nobody${tag}@t.io`, password: pw });
  const bad2 = await c.call('POST', '/api/auth/login', { email: `a${tag}@t.io`, password: 'wrong wrong wrong' });
  assert.equal(bad.status, 401); assert.equal(bad.data.error, bad2.data.error);
  const good = await c.call('POST', '/api/auth/login', { email: `a${tag}@t.io`, password: pw });
  assert.equal(good.status, 200);
  c.csrf = '';
  const noCsrf = await c.call('POST', '/api/auth/logout');
  assert.equal(noCsrf.status, 403);
  const crossOrigin = await c.call('POST', '/api/auth/logout', null, { headers: { origin: 'https://evil.example', 'x-csrf-token': 'x' } });
  assert.equal(crossOrigin.status, 403);

  const victim = new Client();
  await victim.call('POST', '/api/auth/register', { email: `v${tag}@t.io`, password: pw, displayName: 'Victim', acceptTerms: true });
  for (let i = 0; i < 5; i++) await new Client().call('POST', '/api/auth/login', { email: `v${tag}@t.io`, password: 'nope nope nope nope' });
  const locked = await new Client().call('POST', '/api/auth/login', { email: `v${tag}@t.io`, password: pw });
  assert.equal(locked.status, 401, 'correct password is refused while locked');
});

let ayu, obsId, mediaId, storageKey;
test('upload is validated, stripped, encrypted at rest, and round-trips', async () => {
  ayu = new Client();
  await ayu.call('POST', '/api/auth/login', { email: `a${tag}@t.io`, password: pw });

  const fake = new FormData();
  fake.append('files', new Blob(['<?php echo 1; ?>'], { type: 'image/jpeg' }), 'x.jpg');
  const rejected = await ayu.call('POST', '/api/observations', fake);
  assert.equal(rejected.status, 400, 'non-image content is rejected even with an image MIME type');

  const up = await ayu.call('POST', '/api/observations', await uploadForm());
  assert.equal(up.status, 201, JSON.stringify(up.data));
  obsId = up.data.observation.id; mediaId = up.data.observation.media[0].id;
  assert.equal(up.data.observation.cell.lat, -6.85, 'only a coarse grid cell is exposed');

  const { rows: [m] } = await owner.query('SELECT * FROM media WHERE id = $1', [mediaId]);
  storageKey = m.storage_key;
  const onDisk = await fs.readFile(path.resolve(config.uploadDir, storageKey.slice(0, 2), storageKey.slice(2, 4), storageKey + '.bin'));
  assert.notEqual(onDisk.subarray(0, 2).toString('hex'), 'ffd8', 'file on disk is ciphertext, not a JPEG');
  const { rows: [o] } = await owner.query('SELECT notes_enc, geo_enc FROM observations WHERE id = $1', [obsId]);
  assert.ok(!o.notes_enc.toString().includes('secret note'));
  assert.ok(!o.geo_enc.toString().includes('-6.9'));

  const dl = await ayu.call('GET', `/api/media/${mediaId}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.data.subarray(0, 2).toString('hex'), 'ffd8');
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  const th = await ayu.call('GET', `/api/media/${mediaId}/thumb`);
  assert.equal(th.status, 200);
});

test('tampered ciphertext is detected', async () => {
  const f = path.resolve(config.uploadDir, storageKey.slice(0, 2), storageKey.slice(2, 4), storageKey + '.bin');
  const orig = await fs.readFile(f); const bad = Buffer.from(orig); bad[10] ^= 0xff;
  await fs.writeFile(f, bad);
  const r = await ayu.call('GET', `/api/media/${mediaId}`);
  await fs.writeFile(f, orig);
  assert.equal(r.status, 500);
});

test('other users cannot read or touch someone else\'s data (IDOR + RLS)', async () => {
  const bo = new Client();
  await bo.call('POST', '/api/auth/register', { email: `b${tag}@t.io`, password: pw, displayName: 'Budi', acceptTerms: true });
  assert.equal((await bo.call('GET', `/api/observations/${obsId}`)).status, 404);
  assert.equal((await bo.call('GET', `/api/media/${mediaId}`)).status, 404);
  assert.equal((await bo.call('DELETE', `/api/observations/${obsId}`)).status, 404);
  assert.equal((await bo.call('POST', `/api/observations/${obsId}/identify`, { choice: 'unsure' })).status, 404);
  assert.equal((await bo.call('GET', '/api/research/overview')).status, 403);
  assert.equal((await new Client().call('GET', `/api/media/${mediaId}`)).status, 401);

  // Even raw SQL through the app's own DB role sees nothing without an identity.
  const { rowCount } = await pool.query('SELECT * FROM observations');
  assert.equal(rowCount, 0);
  const { rowCount: mc } = await pool.query('SELECT * FROM media');
  assert.equal(mc, 0);
});

test('points, badges and challenges are computed on the server', async () => {
  const r = await ayu.call('POST', `/api/observations/${obsId}/identify`, { choice: 'manual', speciesSlug: 'ladybug' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.pointsAwarded, 100);
  assert.ok(r.data.unlocked.includes('First Discovery'));
  assert.equal((await ayu.call('POST', `/api/observations/${obsId}/identify`, { choice: 'manual', speciesSlug: 'ladybug' })).status, 409, 'cannot farm points twice');
  const s = await ayu.call('GET', '/api/play/summary');
  assert.equal(s.data.points, 100); assert.equal(s.data.speciesFound, 1);
  assert.equal((await ayu.call('POST', '/api/play/challenges/4/claim')).status, 200);
  assert.equal((await ayu.call('POST', '/api/play/challenges/4/claim')).status, 400, 'reward is claimable once');
});

let sari;
test('researcher access needs a password AND a one-time code (and codes cannot be replayed)', async () => {
  const email = `sari${tag}@t.io`;
  await owner.query(`INSERT INTO users (email_enc, email_hash, display_name, password_hash, role) VALUES ($1,$2,'Dr Sari',$3,'researcher')`,
    [encryptField(email, 'users.email'), emailBlindIndex(email), await hashPassword(pw)]);
  sari = new Client();
  const login = await sari.call('POST', '/api/auth/login', { email, password: pw });
  assert.equal(login.data.mfa, 'setup');
  assert.equal((await sari.call('GET', '/api/research/overview')).status, 401, 'password alone is not enough');
  const setup = await sari.call('POST', '/api/auth/mfa/setup');
  assert.ok(setup.data.qr.startsWith('data:image/png'));
  assert.equal((await sari.call('POST', '/api/auth/mfa/verify', { code: '000000' })).status, 401);
  const code = generateSync({ secret: setup.data.secret });
  assert.equal((await sari.call('POST', '/api/auth/mfa/verify', { code })).status, 200);
  assert.equal((await sari.call('GET', '/api/research/overview')).status, 200);

  const again = new Client();
  assert.equal((await again.call('POST', '/api/auth/login', { email, password: pw })).data.mfa, 'verify');
  assert.equal((await again.call('POST', '/api/auth/mfa/verify', { code })).status, 401, 'the same code cannot be used twice');
});

test('researchers only see consented uploads and can review them', async () => {
  const { rows: [priv] } = await owner.query(`SELECT count(*)::int AS n FROM observations WHERE consent_research = false`);
  assert.ok(priv.n >= 0);
  const q = await sari.call('GET', '/api/research/observations?status=pending');
  assert.equal(q.status, 200);
  const d = await sari.call('GET', `/api/research/observations/${obsId}`);
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const img = await sari.call('GET', d.data.media[0].url);
  assert.equal(img.status, 200);
  const loc = await sari.call('GET', `/api/research/observations/${obsId}/location`);
  assert.equal(loc.data.lat, -6.9);
  const v = await sari.call('POST', `/api/research/observations/${obsId}/review`, { decision: 'verify', speciesSlug: 'ladybug' });
  assert.equal(v.status, 200);
  assert.ok((await sari.call('GET', '/api/research/dataset')).data.species.find((s) => s.slug === 'ladybug').verifiedImages >= 1);

  // A private (non-consenting) upload is invisible to researchers.
  const priv2 = await (async () => {
    const c = new Client();
    await c.call('POST', '/api/auth/register', { email: `p${tag}@t.io`, password: pw, displayName: 'Private', acceptTerms: true, consentResearch: false });
    const up = await c.call('POST', '/api/observations', await uploadForm());
    return { c, id: up.data.observation.id, media: up.data.observation.media[0].id };
  })();
  assert.equal((await sari.call('GET', `/api/research/observations/${priv2.id}`)).status, 404);
  assert.equal((await sari.call('GET', `/api/media/${priv2.media}`)).status, 404);
});

test('training jobs are validated before they are queued', async () => {
  const r = await sari.call('POST', '/api/research/training', { arch: 'resnet18', epochs: 5, minPerClass: 20 });
  assert.equal(r.status, 400);
  assert.equal((await sari.call('POST', '/api/research/training', { arch: 'evil; drop table' })).status, 400);
});

test('account deletion removes rows and encrypted files', async () => {
  const c = new Client();
  await c.call('POST', '/api/auth/register', { email: `d${tag}@t.io`, password: pw, displayName: 'Delete Me', acceptTerms: true });
  const up = await c.call('POST', '/api/observations', await uploadForm());
  const { rows: [m] } = await owner.query('SELECT storage_key FROM media WHERE id = $1', [up.data.observation.media[0].id]);
  const f = path.resolve(config.uploadDir, m.storage_key.slice(0, 2), m.storage_key.slice(2, 4), m.storage_key + '.bin');
  await fs.access(f);
  assert.equal((await c.call('DELETE', '/api/me', { password: 'wrong wrong wrong' })).status, 401);
  assert.equal((await c.call('DELETE', '/api/me', { password: pw })).status, 200);
  await assert.rejects(fs.access(f));
  assert.equal((await owner.query('SELECT 1 FROM media WHERE id = $1', [up.data.observation.media[0].id])).rowCount, 0);
});

test('audit log is append-only and tamper-evident', async () => {
  assert.equal((await verifyChain(owner)).ok, true);
  await assert.rejects(pool.query(`UPDATE audit_log SET action = 'x'`), /permission denied/);
  await assert.rejects(pool.query(`DELETE FROM audit_log`), /permission denied/);
  const { rows: [first] } = await owner.query('SELECT id, action FROM audit_log ORDER BY id LIMIT 1');
  await owner.query(`UPDATE audit_log SET action = 'tampered' WHERE id = $1`, [first.id]);
  const broken = await verifyChain(owner);
  await owner.query('UPDATE audit_log SET action = $2 WHERE id = $1', [first.id, first.action]); // restore
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenAt, first.id);
});
