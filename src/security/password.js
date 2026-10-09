import argon2 from 'argon2';
import crypto from 'node:crypto';
import { config } from '../config.js';

// Argon2id, 64 MiB, 3 passes (above OWASP's minimum). The password is first run
// through HMAC with a server-side pepper, so a stolen database alone is not
// enough to even start guessing passwords offline.
const OPTS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };
const peppered = (pw) => crypto.createHmac('sha256', config.keys.pepper).update(pw.normalize('NFKC')).digest('base64');

export const hashPassword = (pw) => argon2.hash(peppered(pw), OPTS);
export async function verifyPassword(hash, pw) {
  try { return await argon2.verify(hash, peppered(pw)); } catch { return false; }
}
export const needsRehash = (hash) => argon2.needsRehash(hash, OPTS);

// A real hash used to burn equal time when the email does not exist,
// so response timing never reveals which emails are registered.
export const DUMMY_HASH = await argon2.hash('dummy-password-for-timing', OPTS);

const COMMON = new Set(['password1234','123456789012','qwertyuiop12','iloveyou1234','welcome12345',
  'bioquest1234','indonesia1234','administrator','letmein123456','password12345','passw0rd1234']);

/** NIST 800-63B style: length first, no composition rules, block the obvious. */
export function checkPasswordPolicy(pw, { email = '', name = '' } = {}) {
  if (typeof pw !== 'string') return 'Password is required.';
  if (pw.length < 12) return 'Use at least 12 characters. A short sentence works well.';
  if (pw.length > 128) return 'Password is too long (128 characters max).';
  const low = pw.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(pw)) return 'That password is too easy to guess. Try something longer and less common.';
  const local = email.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && low.includes(local)) return 'Your password should not contain your email.';
  if (name && name.length >= 4 && low.includes(name.toLowerCase())) return 'Your password should not contain your display name.';
  return null;
}
