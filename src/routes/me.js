import { Router } from 'express';
import { z } from 'zod';
import { query, withIdentity } from '../db.js';
import { requireAuth, clearSessionCookie } from '../middleware/auth.js';
import { verifyPassword } from '../security/password.js';
import { decryptField } from '../security/crypto.js';
import { removeCiphertext } from '../services/vault.js';
import { audit } from '../services/audit.js';
import { loginLimiter } from '../middleware/limits.js';

export const me = Router();
me.use(requireAuth);

me.post('/onboarded', async (req, res, next) => {
  try { await query('UPDATE users SET onboarded = true WHERE id = $1', [req.auth.user.id]); res.json({ ok: true }); } catch (e) { next(e); }
});

me.patch('/profile', async (req, res, next) => {
  try {
    const b = z.object({
      displayName: z.string().trim().min(2).max(30).regex(/^[\p{L}\p{N} ._'-]+$/u).optional(),
      community: z.string().trim().min(2).max(60).optional()
    }).strict().parse(req.body);
    await query('UPDATE users SET display_name = COALESCE($2, display_name), community = COALESCE($3, community) WHERE id = $1',
      [req.auth.user.id, b.displayName ?? null, b.community ?? null]);
    await audit(req, 'profile.update');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Research-sharing consent. Switching it off can also withdraw existing uploads
// from the research dataset (already-trained models cannot be "un-trained").
me.patch('/consent', async (req, res, next) => {
  try {
    const b = z.object({ research: z.boolean(), applyToExisting: z.boolean().default(false) }).strict().parse(req.body);
    const withdrawn = await withIdentity(req.auth.user, async (db) => {
      await db.query('UPDATE users SET consent_research = $2, consent_at = now() WHERE id = $1', [req.auth.user.id, b.research]);
      if (b.applyToExisting) {
        const r = await db.query('UPDATE observations SET consent_research = $2 WHERE user_id = $1', [req.auth.user.id, b.research]);
        return r.rowCount;
      }
      return 0;
    });
    await audit(req, 'consent.change', { meta: { research: b.research, applied: withdrawn } });
    res.json({ ok: true, updated: withdrawn });
  } catch (e) { next(e); }
});

// Download everything we hold about you (data portability).
me.get('/export', async (req, res, next) => {
  try {
    const user = req.auth.user;
    const data = await withIdentity(user, async (db) => {
      const { rows: [u] } = await db.query('SELECT email_enc, display_name, community, points, created_at, consent_research FROM users WHERE id = $1', [user.id]);
      const obs = await db.query(
        `SELECT o.id, s.common_name AS species, o.status, o.place_label, o.notes_enc, o.geo_enc, o.observed_at, o.consent_research,
                (SELECT json_agg(json_build_object('id', m.id, 'kind', m.kind, 'bytes', m.bytes)) FROM media m WHERE m.observation_id = o.id) AS media
           FROM observations o LEFT JOIN species s ON s.id = o.species_id WHERE o.user_id = $1 ORDER BY o.observed_at`, [user.id]);
      return {
        profile: { email: decryptField(u.email_enc, 'users.email'), displayName: u.display_name, community: u.community, points: u.points,
                   createdAt: u.created_at, shareForResearch: u.consent_research },
        observations: obs.rows.map((o) => ({
          id: o.id, species: o.species, status: o.status, place: o.place_label, observedAt: o.observed_at, shareForResearch: o.consent_research,
          notes: o.notes_enc ? decryptField(o.notes_enc, 'observations.notes') : null,
          location: o.geo_enc ? JSON.parse(decryptField(o.geo_enc, 'observations.geo')) : null, files: o.media ?? []
        }))
      };
    });
    await audit(req, 'account.export');
    res.setHeader('Content-Disposition', 'attachment; filename="bioquest-my-data.json"');
    res.json(data);
  } catch (e) { next(e); }
});

// Permanently delete the account, its database rows and its encrypted files.
me.delete('/', loginLimiter, async (req, res, next) => {
  try {
    const { password } = z.object({ password: z.string().max(200) }).strict().parse(req.body);
    const user = req.auth.user;
    if (user.role === 'researcher') return res.status(403).json({ error: 'Ask an administrator to remove researcher accounts.' });
    const { rows: [u] } = await query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!(await verifyPassword(u.password_hash, password))) return res.status(401).json({ error: 'Password is incorrect.' });
    const keys = await withIdentity(user, async (db) => {
      const { rows } = await db.query('SELECT storage_key, thumb_key FROM media WHERE owner_id = $1', [user.id]);
      await db.query('DELETE FROM users WHERE id = $1', [user.id]);
      return rows.flatMap((r) => [r.storage_key, r.thumb_key]).filter(Boolean);
    });
    await Promise.all(keys.map(removeCiphertext));
    await audit(req, 'account.delete', { actorId: null, target: user.id });
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
