import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { query } from '../db.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword, needsRehash, checkPasswordPolicy, DUMMY_HASH } from '../security/password.js';
import { encryptField, decryptField, emailBlindIndex } from '../security/crypto.js';
import { createSession, rotateCsrf, clearSessionCookie, requireAuth } from '../middleware/auth.js';
import { loginLimiter, registerLimiter, mfaLimiter } from '../middleware/limits.js';
import { audit } from '../services/audit.js';

export const auth = Router();

const email = z.string().trim().toLowerCase().email().max(254);
const GENERIC_LOGIN_ERROR = 'Email or password is incorrect, or the account is temporarily locked.';

const publicUser = (u) => ({
  id: u.id, role: u.role, displayName: u.displayName ?? u.display_name,
  consentResearch: u.consentResearch ?? u.consent_research, onboarded: u.onboarded, community: u.community
});

auth.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const body = z.object({
      email, password: z.string().max(200),
      displayName: z.string().trim().min(2).max(30).regex(/^[\p{L}\p{N} ._'-]+$/u, 'Use letters, numbers and simple punctuation.'),
      community: z.string().trim().max(60).optional(),
      consentResearch: z.boolean().default(false),
      acceptTerms: z.literal(true, { error: 'Please accept the privacy notice to continue.' })
    }).strict().parse(req.body);

    const problem = checkPasswordPolicy(body.password, { email: body.email, name: body.displayName });
    if (problem) return res.status(400).json({ error: problem });

    const passwordHash = await hashPassword(body.password);
    const ins = await query(
      `INSERT INTO users (email_enc, email_hash, display_name, community, password_hash, consent_research, consent_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6 THEN now() END)
       ON CONFLICT (email_hash) DO NOTHING RETURNING id, role, display_name, community, consent_research, onboarded`,
      [encryptField(body.email, 'users.email'), emailBlindIndex(body.email), body.displayName,
       body.community || 'My Community', passwordHash, body.consentResearch]
    );
    if (!ins.rows[0]) {
      // Same answer whether or not the email exists, so sign-up can't be used to probe for accounts.
      return res.status(400).json({ error: 'We could not create that account. If you already signed up, try signing in.' });
    }
    const user = ins.rows[0];
    const csrf = await createSession(req, res, user, { mfaPassed: true });
    await audit(req, 'user.register', { actorId: user.id, target: user.id, meta: { consentResearch: body.consentResearch } });
    res.status(201).json({ user: publicUser(user), csrfToken: csrf });
  } catch (e) { next(e); }
});

auth.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const body = z.object({ email, password: z.string().min(1).max(200) }).strict().parse(req.body);
    const { rows } = await query('SELECT * FROM users WHERE email_hash = $1', [emailBlindIndex(body.email)]);
    const u = rows[0];

    if (!u) { await verifyPassword(DUMMY_HASH, body.password); // equalise timing
      await audit(req, 'login.fail', { meta: { reason: 'unknown' } });
      return res.status(401).json({ error: GENERIC_LOGIN_ERROR }); }

    if (u.disabled || (u.locked_until && new Date(u.locked_until) > new Date())) {
      await verifyPassword(DUMMY_HASH, body.password);
      await audit(req, 'login.blocked', { actorId: u.id });
      return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    }

    const ok = await verifyPassword(u.password_hash, body.password);
    if (!ok) {
      const lock = u.failed_logins + 1 >= config.limits.maxFailedLogins;
      await query(
        `UPDATE users SET failed_logins = CASE WHEN $2 THEN 0 ELSE failed_logins + 1 END,
                locked_until = CASE WHEN $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
          WHERE id = $1`, [u.id, lock, String(config.limits.lockMinutes)]);
      await audit(req, lock ? 'login.locked' : 'login.fail', { actorId: u.id });
      return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    }

    if (needsRehash(u.password_hash)) {
      await query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await hashPassword(body.password)]);
    }
    await query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);

    const needsMfa = u.role === 'researcher';
    const csrf = await createSession(req, res, u, { mfaPassed: !needsMfa });
    await audit(req, 'login.ok', { actorId: u.id, meta: { mfaPending: needsMfa } });
    res.json({
      user: publicUser(u), csrfToken: csrf,
      mfa: needsMfa ? (u.mfa_enabled ? 'verify' : 'setup') : null
    });
  } catch (e) { next(e); }
});

// Session info (also refreshes the CSRF token after a page reload).
auth.get('/me', async (req, res, next) => {
  try {
    if (!req.auth) return res.json({ user: null });
    const csrf = await rotateCsrf(req.auth.sessionId);
    const u = req.auth.user;
    res.json({
      user: publicUser(u), csrfToken: csrf,
      mfa: u.role === 'researcher' && !req.auth.mfaPassed ? (u.mfaEnabled ? 'verify' : 'setup') : null
    });
  } catch (e) { next(e); }
});

auth.post('/logout', async (req, res, next) => {
  try {
    if (req.auth) {
      await query('DELETE FROM sessions WHERE id = $1', [req.auth.sessionId]);
      await audit(req, 'logout');
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- two-factor (mandatory for researchers) ---------------------------------
const needResearcherSession = (req, res, next) => {
  if (req.auth?.user.role !== 'researcher') return res.status(403).json({ error: 'Two-factor is only used for researcher accounts.' });
  next();
};

auth.post('/mfa/setup', mfaLimiter, needResearcherSession, async (req, res, next) => {
  try {
    if (req.auth.user.mfaEnabled) return res.status(409).json({ error: 'Two-factor is already set up. Ask an administrator to reset it.' });
    const secret = generateSecret();
    await query('UPDATE users SET mfa_secret_enc = $2 WHERE id = $1', [req.auth.user.id, encryptField(secret, 'users.mfa')]);
    const uri = generateURI({ issuer: 'BioQuest Research', label: req.auth.user.displayName, secret });
    res.json({ secret, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
  } catch (e) { next(e); }
});

auth.post('/mfa/verify', mfaLimiter, needResearcherSession, async (req, res, next) => {
  try {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.') }).strict().parse(req.body);
    const { rows: [u] } = await query('SELECT mfa_secret_enc, mfa_last_step FROM users WHERE id = $1', [req.auth.user.id]);
    if (!u?.mfa_secret_enc) return res.status(400).json({ error: 'Start two-factor setup first.' });
    const secret = decryptField(u.mfa_secret_enc, 'users.mfa');
    const r = verifySync({ secret, token: code, epochTolerance: 30 });
    // A code that was already used (replay) is rejected even if it is still in its time window.
    if (!r.valid || r.timeStep <= u.mfa_last_step) {
      await audit(req, 'mfa.fail');
      return res.status(401).json({ error: 'That code is not valid. Check your authenticator app and try again.' });
    }
    await query('UPDATE users SET mfa_enabled = true, mfa_last_step = $2 WHERE id = $1', [req.auth.user.id, r.timeStep]);
    await query('UPDATE sessions SET mfa_passed = true WHERE id = $1', [req.auth.sessionId]);
    await audit(req, 'mfa.ok');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- password change --------------------------------------------------------
auth.post('/password', requireAuth, loginLimiter, async (req, res, next) => {
  try {
    const body = z.object({ current: z.string().max(200), next: z.string().max(200) }).strict().parse(req.body);
    const { rows: [u] } = await query('SELECT password_hash, display_name FROM users WHERE id = $1', [req.auth.user.id]);
    if (!(await verifyPassword(u.password_hash, body.current))) return res.status(401).json({ error: 'Your current password is incorrect.' });
    const problem = checkPasswordPolicy(body.next, { name: u.display_name });
    if (problem) return res.status(400).json({ error: problem });
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.auth.user.id, await hashPassword(body.next)]);
    // Sign out every other device.
    await query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.auth.user.id, req.auth.sessionId]);
    await audit(req, 'password.change');
    res.json({ ok: true });
  } catch (e) { next(e); }
});
