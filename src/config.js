// Central, validated configuration. The server refuses to start with weak or
// missing secrets, so a misconfigured deployment fails loudly, not silently.

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function secretHex(name, bytes = 32) {
  const v = env[name];
  if (!v) throw new Error(`Missing ${name}. Run "npm run setup" to generate secrets.`);
  if (!/^[0-9a-f]+$/i.test(v) || v.length !== bytes * 2) {
    throw new Error(`${name} must be ${bytes * 2} hex characters (${bytes} random bytes).`);
  }
  return Buffer.from(v, 'hex');
}

// Master keys can be rotated: MEDIA_KEK_<n>. The highest n is used for new files.
function loadKeks() {
  const keks = new Map();
  for (const k of Object.keys(env)) {
    const m = /^MEDIA_KEK_(\d+)$/.exec(k);
    if (m) keks.set(Number(m[1]), secretHex(k));
  }
  if (keks.size === 0) throw new Error('Missing MEDIA_KEK_1. Run "npm run setup".');
  return keks;
}

export const config = {
  isProd,
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || '',
  trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) : (isProd ? 1 : 0),
  publicOrigin: env.PUBLIC_ORIGIN || `http://localhost:${env.PORT || 3000}`,
  uploadDir: env.UPLOAD_DIR || './storage/vault',
  modelDir: env.MODEL_DIR || './storage/models',
  get keys() {
    if (!this._keys) {
      const keks = loadKeks();
      this._keys = {
        keks,
        currentKek: Math.max(...keks.keys()),
        field: secretHex('FIELD_ENCRYPTION_KEY'),   // encrypts emails, notes, GPS, MFA secrets
        hmac: secretHex('HMAC_KEY'),                // blind index, IP/UA hashing, audit chain
        pepper: secretHex('PASSWORD_PEPPER')        // mixed into every password hash
      };
    }
    return this._keys;
  },
  limits: {
    imageBytes: 12 * 1024 * 1024,
    videoBytes: 40 * 1024 * 1024,
    filesPerObservation: 3,
    sessionIdleMinutes: 60,
    sessionAbsoluteHours: 12,
    researcherIdleMinutes: 20,
    researcherAbsoluteHours: 8,
    maxFailedLogins: 5,
    lockMinutes: 15
  }
};
