// All cryptography lives here so it can be reviewed in one place.
// Primitives: AES-256-GCM (authenticated encryption), HMAC-SHA-256, SHA-256, CSPRNG.
import crypto from 'node:crypto';
import { config } from '../config.js';

const IV_LEN = 12;
const TAG_LEN = 16;

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
export const hmac = (data) => crypto.createHmac('sha256', config.keys.hmac).update(data).digest();

export function safeEqual(a, b) {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const y = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Encrypt a small value (email, notes, GPS...). `context` is authenticated, so a
 *  ciphertext copied from one column can never be decrypted as another. */
export function encryptField(plain, context) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', config.keys.field, iv);
  c.setAAD(Buffer.from(context));
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decryptField(blob, context) {
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', config.keys.field, iv);
  d.setAAD(Buffer.from(context));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** Keyed hash of a normalised email: lets us look users up without storing the email. */
export const emailBlindIndex = (email) => hmac('email:' + email.trim().toLowerCase());

/** Hash an IP / user-agent for abuse detection without keeping the raw value. */
export const hashMeta = (v) => (v ? hmac('meta:' + v) : null);

// ---- envelope encryption for uploaded files --------------------------------
// plaintext --AES-GCM(DEK)--> ciphertext ; DEK --AES-GCM(KEK)--> wrapped DEK
export function wrapKey(dek, version = config.keys.currentKek) {
  const kek = config.keys.keks.get(version);
  if (!kek) throw new Error(`KEK version ${version} not configured`);
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(Buffer.from('dek:v' + version));
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function unwrapKey(wrapped, version) {
  const kek = config.keys.keks.get(version);
  if (!kek) throw new Error(`KEK version ${version} not configured`);
  const d = crypto.createDecipheriv('aes-256-gcm', kek, wrapped.subarray(0, IV_LEN));
  d.setAAD(Buffer.from('dek:v' + version));
  d.setAuthTag(wrapped.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([d.update(wrapped.subarray(IV_LEN + TAG_LEN)), d.final()]);
}

export function encryptFileBuffer(plain) {
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const out = { ct, iv, tag: c.getAuthTag(), dekWrapped: wrapKey(dek), kekVersion: config.keys.currentKek };
  dek.fill(0);
  return out;
}

export function decryptFileBuffer(ct, { dekWrapped, kekVersion, iv, tag }) {
  const dek = unwrapKey(dekWrapped, kekVersion);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', dek, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } finally {
    dek.fill(0);
  }
}
