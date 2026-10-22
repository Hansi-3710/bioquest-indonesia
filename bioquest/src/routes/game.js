import { Router } from 'express';
import { z } from 'zod';
import { query, withIdentity } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { challengeProgress, badgesFor, levelOf, CHALLENGES, weekStart } from '../services/progress.js';
import { speciesDto } from '../services/dto.js';
import { audit } from '../services/audit.js';

export const game = Router();
game.use(requireAuth);

// Species guide, with the signed-in user's own discovery data merged in.
game.get('/species', async (req, res, next) => {
  try {
    const user = req.auth.user;
    const out = await withIdentity(user, async (db) => {
      const sp = await db.query('SELECT * FROM species ORDER BY common_name');
      const mine = await db.query(
        `SELECT species_id, count(*)::int AS n, min(observed_at) AS first_at,
                (array_agg(place_label ORDER BY observed_at))[1] AS first_place
           FROM observations WHERE user_id = $1 AND species_id IS NOT NULL AND user_choice <> 'none' GROUP BY species_id`, [user.id]);
      const byId = new Map(mine.rows.map((r) => [r.species_id, r]));
      return sp.rows.map((s) => {
        const m = byId.get(s.id);
        return { ...speciesDto(s), found: !!m, count: m?.n ?? 0, firstAt: m?.first_at ?? null, firstPlace: m?.first_place ?? null };
      });
    });
    res.json({ species: out });
  } catch (e) { next(e); }
});

// Everything the home / profile screens need in one call.
game.get('/summary', async (req, res, next) => {
  try {
    const user = req.auth.user;
    const out = await withIdentity(user, async (db) => {
      const { rows: [u] } = await db.query('SELECT display_name, community, points, species_found, observation_count FROM users WHERE id = $1', [user.id]);
      const { rows: [{ total }] } = await db.query('SELECT count(*)::int AS total FROM species');
      const challenges = await challengeProgress(db, user.id);
      const badges = await badgesFor(db, user.id);
      return {
        displayName: u.display_name, community: u.community, points: u.points, level: levelOf(u.points), xp: u.points % 1000,
        speciesFound: u.species_found, speciesTotal: total, observations: u.observation_count,
        challenges, badges, challengesDone: challenges.filter((c) => c.claimed).length
      };
    });
    res.json(out);
  } catch (e) { next(e); }
});

game.post('/challenges/:id/claim', async (req, res, next) => {
  try {
    const id = z.coerce.number().int().parse(req.params.id);
    const def = CHALLENGES.find((c) => c.id === id);
    if (!def) return res.status(404).json({ error: 'Challenge not found.' });
    const user = req.auth.user;
    const out = await withIdentity(user, async (db) => {
      const prog = (await challengeProgress(db, user.id)).find((c) => c.id === id);
      if (!prog.ready) return { error: prog.claimed ? 'Reward already claimed.' : 'Finish the challenge first.' };
      const ins = await db.query(
        'INSERT INTO challenge_claims (user_id, week_start, challenge_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [user.id, weekStart(), id]);
      if (!ins.rowCount) return { error: 'Reward already claimed.' };
      const { rows: [u] } = await db.query('UPDATE users SET points = points + $2 WHERE id = $1 RETURNING points', [user.id, def.reward]);
      return { reward: def.reward, points: u.points, level: levelOf(u.points) };
    });
    if (out.error) return res.status(400).json(out);
    await audit(req, 'challenge.claim', { target: String(id) });
    res.json(out);
  } catch (e) { next(e); }
});

// Leaderboard shows display names only, never emails or exact stats beyond points/species.
game.get('/leaderboard', async (req, res, next) => {
  try {
    const scope = z.enum(['community', 'all']).default('community').parse(req.query.scope);
    const me = req.auth.user;
    const { rows } = await query(
      `SELECT id, display_name, points, species_found FROM users
        WHERE role = 'user' AND NOT disabled AND observation_count > 0 ${scope === 'community' ? 'AND community = $1' : ''}
        ORDER BY points DESC, species_found DESC LIMIT 25`,
      scope === 'community' ? [me.community] : []);
    res.json({
      scope, community: me.community,
      rows: rows.map((r, i) => ({ rank: i + 1, name: r.display_name, points: r.points, species: r.species_found, me: r.id === me.id }))
    });
  } catch (e) { next(e); }
});

// The user's own sightings on a coarse grid (never exact coordinates).
game.get('/map', async (req, res, next) => {
  try {
    const scope = z.enum(['mine', 'animals', 'all']).default('all').parse(req.query.scope);
    const user = req.auth.user;
    const rows = await withIdentity(user, async (db) => {
      const { rows } = await db.query(
        `SELECT o.id, o.cell_lat AS lat, o.cell_lon AS lon, s.slug, s.common_name AS name, s.kind
           FROM observations o JOIN species s ON s.id = o.species_id
          WHERE o.user_id = $1 AND o.cell_lat IS NOT NULL AND o.user_choice <> 'none'
            ${scope === 'animals' ? "AND s.kind NOT IN ('tree','flower')" : ''}
          ORDER BY o.observed_at DESC LIMIT 300`, [user.id]);
      return rows;
    });
    res.json({ pins: rows });
  } catch (e) { next(e); }
});
