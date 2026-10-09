import { query } from '../db.js';
import { config } from '../config.js';
import { randomToken, sha256, safeEqual, hashMeta } from '../security/crypto.js';

export const COOKIE = config.isProd ? '__Host-bq' : 'bq';

const cookieOpts = (maxAgeMs) => ({
  httpOnly: true,                 // JavaScript can never read the session
  secure: config.isProd,          // HTTPS only in production
  sameSite: 'strict',             // never sent on cross-site requests
  path: '/',
  maxAge: maxAgeMs
});

const idleMinutes = (role) => (role === 'researcher' ? config.limits.researcherIdleMinutes : config.limits.sessionIdleMinutes);
const absHours = (role) => (role === 'researcher' ? config.limits.researcherAbsoluteHours : config.limits.sessionAbsoluteHours);

export async function createSession(req, res, user, { mfaPassed }) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const ttlMs = absHours(user.role) * 3600e3;
  await query(
    `INSERT INTO sessions (user_id, token_hash, csrf_hash, mfa_passed, ip_hash, ua_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' milliseconds')::interval)`,
    [user.id, sha256(token), sha256(csrf), mfaPassed, hashMeta(req.ip), hashMeta(req.get('user-agent')), String(ttlMs)]
  );
  res.cookie(COOKIE, token, cookieOpts(ttlMs));
  return csrf;
}

export async function rotateCsrf(sessionId) {
  const csrf = randomToken(24);
  await query('UPDATE sessions SET csrf_hash = $2 WHERE id = $1', [sessionId, sha256(csrf)]);
  return csrf;
}

export const clearSessionCookie = (res) => res.clearCookie(COOKIE, cookieOpts(0));

/** Attach req.auth if the cookie maps to a live session. Never throws on bad cookies. */
export async function loadSession(req, res, next) {
  req.auth = null;
  const token = req.cookies?.[COOKIE];
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return next();
  try {
    const { rows } = await query(
      `SELECT s.id AS sid, s.csrf_hash, s.mfa_passed, s.last_seen_at,
              u.id, u.role, u.display_name, u.disabled, u.mfa_enabled, u.consent_research, u.onboarded, u.community
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
    const r = rows[0];
    if (!r || r.disabled) { if (r) clearSessionCookie(res); return next(); }
    const idleMs = idleMinutes(r.role) * 60e3;
    if (Date.now() - new Date(r.last_seen_at).getTime() > idleMs) {
      await query('DELETE FROM sessions WHERE id = $1', [r.sid]);
      clearSessionCookie(res);
      return next();
    }
    if (Date.now() - new Date(r.last_seen_at).getTime() > 60e3) {
      query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [r.sid]).catch(() => {});
    }
    req.auth = {
      sessionId: r.sid, csrfHash: r.csrf_hash, mfaPassed: r.mfa_passed,
      user: { id: r.id, role: r.role, displayName: r.display_name, mfaEnabled: r.mfa_enabled,
              consentResearch: r.consent_research, onboarded: r.onboarded, community: r.community }
    };
    next();
  } catch (e) { next(e); }
}

export function requireAuth(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'Please sign in.' });
  // Researchers must finish two-factor before anything else works.
  if (req.auth.user.role === 'researcher' && !req.auth.mfaPassed) {
    return res.status(401).json({ error: 'Two-factor verification required.', mfa: true });
  }
  next();
}

export function requireRole(role) {
  return (req, res, next) => {
    if (req.auth?.user.role !== role) return res.status(403).json({ error: 'You do not have access to this.' });
    next();
  };
}

/** CSRF defence in depth: same-origin check + per-session token on every state-changing request. */
export function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && origin !== new URL(config.publicOrigin).origin) {
    return res.status(403).json({ error: 'Cross-origin request blocked.' });
  }
  const site = req.get('sec-fetch-site');
  if (site && !['same-origin', 'none'].includes(site)) {
    return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  if (req.auth) {
    const sent = req.get('x-csrf-token');
    if (!sent || !safeEqual(sha256(sent), req.auth.csrfHash)) {
      return res.status(403).json({ error: 'Security token missing or expired. Refresh the page.' });
    }
  }
  next();
}
