// Encrypted file vault. Files are stored as opaque ciphertext under random
// names in a private directory that the web server never serves.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const KEY_RE = /^[0-9a-f]{32}$/;
const root = () => path.resolve(config.uploadDir);

function locate(key) {
  if (!KEY_RE.test(key)) throw new Error('invalid storage key');
  return path.join(root(), key.slice(0, 2), key.slice(2, 4), key + '.bin');
}

export async function putCiphertext(ct) {
  const key = crypto.randomBytes(16).toString('hex');
  const file = locate(key);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, ct, { mode: 0o600, flag: 'wx' });
  return key;
}

export const getCiphertext = (key) => fs.readFile(locate(key));
export const removeCiphertext = (key) => fs.rm(locate(key), { force: true });
