import { Router } from 'express';
import { z } from 'zod';
import { query, withIdentity } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { trainingLimiter } from '../middleware/limits.js';
import { decryptField, hmac } from '../security/crypto.js';
import { audit } from '../services/audit.js';
import { recountSpecies, speciesDto, mediaDto } from '../services/dto.js';
import { POINTS } from '../services/progress.js';

export const research = Router();
research.use(requireAuth, requireRole('researcher'));

const R = (req) => ({ id: req.auth.user.id, role: 'researcher' });

// ---- overview ---------------------------------------------------------------
research.get('/overview', async (req, res, next) => {
  try {
    const out = await withIdentity(R(req), async (db) => {
      const { rows: [t] } = await db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status='pending')::int AS pending,
                count(*) FILTER (WHERE status='verified')::int AS verified,
                count(*) FILTER (WHERE status='rejected')::int AS rejected,
                count(DISTINCT user_id)::int AS contributors
           FROM observations`);
      const { rows: [m] } = await db.query('SELECT count(*)::int AS files, COALESCE(sum(bytes),0)::bigint AS bytes FROM media');
      const daily = await db.query(
        `SELECT to_char(d::date, 'YYYY-MM-DD') AS day, COALESCE(c.n, 0)::int AS n
           FROM generate_series(current_date - 29, current_date, '1 day') d
           LEFT JOIN (SELECT date_trunc('day', created_at)::date AS day, count(*) AS n FROM observations GROUP BY 1) c ON c.day = d::date
          ORDER BY d`);
      const cells = await db.query(
        `SELECT cell_lat AS lat, cell_lon AS lon, count(*)::int AS n FROM observations WHERE cell_lat IS NOT NULL GROUP BY 1,2`);
      return { totals: t, media: m, daily: daily.rows, cells: cells.rows };
    });
    const { rows: models } = await query('SELECT count(*)::int AS n FROM models');
    const { rows: [active] } = await query('SELECT id, version, metrics, created_at FROM models WHERE active');
    res.json({ ...out, models: models[0].n, activeModel: active ?? null });
  } catch (e) { next(e); }
});

// ---- review queue -----------------------------------------------------------
const OBS_LIST = `
  SELECT o.id, o.status, o.user_choice, o.ai_confidence, o.observed_at, o.place_label, o.cell_lat, o.cell_lon,
         sp.slug AS sp_slug, sp.common_name AS sp_common_name, sp.iucn_code AS sp_iucn_code, sp.kind AS sp_kind,
         ai.slug AS ai_slug, ai.common_name AS ai_common_name,
         (SELECT id FROM media m WHERE m.observation_id = o.id AND m.kind = 'image' ORDER BY m.created_at LIMIT 1) AS thumb_id
    FROM observations o LEFT JOIN species sp ON sp.id = o.species_id LEFT JOIN species ai ON ai.id = o.ai_species_id`;

research.get('/observations', async (req, res, next) => {
  try {
    const q = z.object({
      status: z.enum(['pending', 'verified', 'rejected']).default('pending'),
      species: z.string().max(80).optional(),
      page: z.coerce.number().int().min(1).max(10000).default(1)
    }).parse(req.query);
    const size = 24;
    const out = await withIdentity(R(req), async (db) => {
      const { rows } = await db.query(
        OBS_LIST + ` WHERE o.status = $1 AND ($2::text IS NULL OR sp.slug = $2) ORDER BY o.created_at ASC LIMIT $3 OFFSET $4`,
        [q.status, q.species ?? null, size, (q.page - 1) * size]);
      const { rows: [c] } = await db.query(
        `SELECT count(*)::int AS n FROM observations o LEFT JOIN species sp ON sp.id = o.species_id WHERE o.status = $1 AND ($2::text IS NULL OR sp.slug = $2)`,
        [q.status, q.species ?? null]);
      return { rows, total: c.n };
    });
    res.json({
      total: out.total, page: q.page, pageSize: size,
      observations: out.rows.map((r) => ({
        id: r.id, status: r.status, userChoice: r.user_choice, observedAt: r.observed_at, place: r.place_label,
        species: r.sp_slug ? { slug: r.sp_slug, name: r.sp_common_name, iucn: r.sp_iucn_code } : null,
        ai: r.ai_slug ? { slug: r.ai_slug, name: r.ai_common_name, confidence: r.ai_confidence } : null,
        thumb: r.thumb_id ? `/api/media/${r.thumb_id}/thumb` : null
      }))
    });
  } catch (e) { next(e); }
});

research.get('/observations/:id', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const out = await withIdentity(R(req), async (db) => {
      const { rows: [o] } = await db.query(
        `SELECT o.*, sp.slug AS sp_slug, sp.common_name AS sp_common_name, sp.iucn_code AS sp_iucn_code, sp.sensitive AS sp_sensitive,
                ai.slug AS ai_slug, ai.common_name AS ai_common_name
           FROM observations o LEFT JOIN species sp ON sp.id = o.species_id LEFT JOIN species ai ON ai.id = o.ai_species_id WHERE o.id = $1`, [id]);
      if (!o) return null;
      const media = (await db.query('SELECT id, kind FROM media WHERE observation_id = $1 ORDER BY created_at', [id])).rows;
      return { o, media };
    });
    if (!out) return res.status(404).json({ error: 'Observation not found, or its owner has not shared it for research.' });
    const { o, media } = out;
    await audit(req, 'research.view_observation', { target: id });
    res.json({
      id: o.id, status: o.status, userChoice: o.user_choice, observedAt: o.observed_at, place: o.place_label,
      notes: o.notes_enc ? decryptField(o.notes_enc, 'observations.notes') : '',
      cell: o.cell_lat == null ? null : { lat: o.cell_lat, lon: o.cell_lon },
      hasExactLocation: !!o.geo_enc,
      species: o.sp_slug ? { slug: o.sp_slug, name: o.sp_common_name, iucn: o.sp_iucn_code, sensitive: o.sp_sensitive } : null,
      ai: o.ai_slug ? { slug: o.ai_slug, name: o.ai_common_name, confidence: o.ai_confidence } : null,
      media: media.map(mediaDto)
    });
  } catch (e) { next(e); }
});

// Exact coordinates are only released on request, and every request is logged.
research.get('/observations/:id/location', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const row = await withIdentity(R(req), async (db) => (await db.query('SELECT geo_enc FROM observations WHERE id = $1', [id])).rows[0]);
    if (!row?.geo_enc) return res.status(404).json({ error: 'No exact location was recorded.' });
    await audit(req, 'research.view_exact_location', { target: id });
    res.json(JSON.parse(decryptField(row.geo_enc, 'observations.geo')));
  } catch (e) { next(e); }
});

research.post('/observations/:id/review', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const b = z.object({ decision: z.enum(['verify', 'reject']), speciesSlug: z.string().max(80).optional() }).strict().parse(req.body);
    const result = await withIdentity(R(req), async (db) => {
      const { rows: [o] } = await db.query('SELECT id, user_id, status, species_id FROM observations WHERE id = $1 FOR UPDATE', [id]);
      if (!o) return { notFound: true };
      let speciesId = o.species_id;
      if (b.speciesSlug) {
        const { rows: [s] } = await db.query('SELECT id FROM species WHERE slug = $1', [b.speciesSlug]);
        if (!s) return { bad: 'Unknown species.' };
        speciesId = s.id;
      }
      if (b.decision === 'verify' && !speciesId) return { bad: 'Choose the correct species before verifying.' };
      const status = b.decision === 'verify' ? 'verified' : 'rejected';
      await db.query(
        `UPDATE observations SET status = $2, species_id = $3, reviewed_by = $4, reviewed_at = now(),
                points_awarded = points_awarded + $5 WHERE id = $1`,
        [id, status, speciesId, req.auth.user.id, status === 'verified' && o.status !== 'verified' ? POINTS.perVerified : 0]);
      return { ownerId: o.user_id, award: status === 'verified' && o.status !== 'verified' };
    });
    if (result.notFound) return res.status(404).json({ error: 'Observation not found.' });
    if (result.bad) return res.status(400).json({ error: result.bad });
    // Derived stats for the owner are recomputed under the owner's own identity.
    await withIdentity({ id: result.ownerId, role: 'user' }, async (db) => {
      if (result.award) await db.query('UPDATE users SET points = points + $2 WHERE id = $1', [result.ownerId, POINTS.perVerified]);
      await recountSpecies(db, result.ownerId);
    });
    await audit(req, 'research.review', { target: id, meta: { decision: b.decision, species: b.speciesSlug ?? null } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- dataset ---------------------------------------------------------------
const MIN_PER_CLASS_DEFAULT = 20;

research.get('/dataset', async (req, res, next) => {
  try {
    const min = z.coerce.number().int().min(2).max(1000).default(MIN_PER_CLASS_DEFAULT).parse(req.query.min);
    const rows = await withIdentity(R(req), async (db) => (await db.query(
      `SELECT s.slug, s.common_name, s.kind, s.iucn_code,
              count(DISTINCT m.id) FILTER (WHERE o.status = 'verified' AND m.kind = 'image')::int AS verified_images,
              count(DISTINCT o.id) FILTER (WHERE o.status = 'pending')::int AS pending
         FROM species s
         LEFT JOIN observations o ON o.species_id = s.id
         LEFT JOIN media m ON m.observation_id = o.id
        GROUP BY s.id ORDER BY verified_images DESC, s.common_name`)).rows);
    const ready = rows.filter((r) => r.verified_images >= min);
    res.json({
      min, species: rows.map((r) => ({ slug: r.slug, name: r.common_name, kind: r.kind, iucn: r.iucn_code,
        verifiedImages: r.verified_images, pending: r.pending, ready: r.verified_images >= min })),
      readyClasses: ready.length, readyImages: ready.reduce((a, r) => a + r.verified_images, 0), canTrain: ready.length >= 2
    });
  } catch (e) { next(e); }
});

// De-identified manifest: no user ids, no exact coordinates, no notes.
research.get('/dataset/manifest.csv', async (req, res, next) => {
  try {
    const rows = await withIdentity(R(req), async (db) => (await db.query(
      `SELECT m.id AS media_id, o.id AS obs_id, s.slug, o.cell_lat, o.cell_lon, o.observed_at::date AS day
         FROM media m JOIN observations o ON o.id = m.observation_id JOIN species s ON s.id = o.species_id
        WHERE o.status = 'verified' AND m.kind = 'image' ORDER BY m.created_at`)).rows);
    await audit(req, 'research.export_manifest', { meta: { rows: rows.length } });
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const anon = (id) => hmac('anon:' + id).subarray(0, 8).toString('hex');
    const lines = ['media_id,observation_ref,species,cell_lat,cell_lon,date',
      ...rows.map((r) => [r.media_id, anon(r.obs_id), r.slug, r.cell_lat, r.cell_lon, r.day?.toISOString?.().slice(0, 10) ?? r.day].map(esc).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bioquest-dataset-manifest.csv"');
    res.send(lines.join('\n') + '\n');
  } catch (e) { next(e); }
});

// ---- training jobs -----------------------------------------------------------
const trainSchema = z.object({
  arch: z.enum(['mobilenet_v3_small', 'efficientnet_b0', 'resnet18']).default('mobilenet_v3_small'),
  epochs: z.number().int().min(1).max(60).default(12),
  minPerClass: z.number().int().min(2).max(1000).default(MIN_PER_CLASS_DEFAULT),
  valSplit: z.number().min(0.1).max(0.4).default(0.2),
  learningRate: z.number().min(1e-5).max(1e-1).default(3e-4),
  imageSize: z.number().int().refine((v) => [160, 224, 256].includes(v)).default(224),
  pretrained: z.boolean().default(true)
}).strict();

research.get('/training', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT j.id, j.status, j.params, j.progress, j.metrics, j.log_tail, j.dataset_size, j.created_at, j.started_at, j.finished_at,
              j.model_id, m.version AS model_version, u.display_name AS requested_by
         FROM training_jobs j LEFT JOIN models m ON m.id = j.model_id JOIN users u ON u.id = j.requested_by
        ORDER BY j.created_at DESC LIMIT 30`);
    res.json({ jobs: rows.map((j) => ({ ...j, requestedBy: j.requested_by, modelVersion: j.model_version, datasetSize: j.dataset_size })) });
  } catch (e) { next(e); }
});

research.post('/training', trainingLimiter, async (req, res, next) => {
  try {
    const p = trainSchema.parse(req.body ?? {});
    const { rows: [busy] } = await query(`SELECT count(*)::int AS n FROM training_jobs WHERE status IN ('queued','running')`);
    if (busy.n >= 2) return res.status(409).json({ error: 'Two jobs are already waiting or running. Wait for one to finish.' });
    const size = await withIdentity(R(req), async (db) => {
      const { rows } = await db.query(
        `SELECT count(DISTINCT m.id)::int AS n FROM media m JOIN observations o ON o.id = m.observation_id
          WHERE o.status = 'verified' AND m.kind = 'image' AND o.species_id IN (
            SELECT species_id FROM observations o2 JOIN media m2 ON m2.observation_id = o2.id
             WHERE o2.status = 'verified' AND m2.kind = 'image' GROUP BY species_id HAVING count(DISTINCT m2.id) >= $1)`, [p.minPerClass]);
      const classes = await db.query(
        `SELECT count(*)::int AS n FROM (SELECT o.species_id FROM observations o JOIN media m ON m.observation_id = o.id
           WHERE o.status = 'verified' AND m.kind = 'image' GROUP BY o.species_id HAVING count(DISTINCT m.id) >= $1) t`, [p.minPerClass]);
      return { images: rows[0].n, classes: classes.rows[0].n };
    });
    if (size.classes < 2) {
      return res.status(400).json({ error: `Training needs at least 2 species with ${p.minPerClass}+ verified photos each. Right now ${size.classes} qualify.` });
    }
    const { rows: [job] } = await query(
      `INSERT INTO training_jobs (requested_by, params, dataset_size) VALUES ($1,$2,$3) RETURNING id`,
      [req.auth.user.id, p, size.images]);
    await audit(req, 'training.request', { target: job.id, meta: p });
    res.status(201).json({ id: job.id });
  } catch (e) { next(e); }
});

research.post('/training/:id/cancel', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const r = await query(`UPDATE training_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status IN ('queued','running')`, [id]);
    if (!r.rowCount) return res.status(409).json({ error: 'That job already finished.' });
    await audit(req, 'training.cancel', { target: id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- models ------------------------------------------------------------------
research.get('/models', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT id, version, arch, metrics, active, created_at, jsonb_array_length(labels) AS classes FROM models ORDER BY version DESC`);
    res.json({ models: rows });
  } catch (e) { next(e); }
});

research.post('/models/:id/activate', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const ok = await withIdentity(R(req), async (db) => {
      const { rows: [m] } = await db.query('SELECT id FROM models WHERE id = $1', [id]);
      if (!m) return false;
      await db.query('UPDATE models SET active = false WHERE active');
      await db.query('UPDATE models SET active = true WHERE id = $1', [id]);
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'Model not found.' });
    await audit(req, 'model.activate', { target: id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

research.post('/models/deactivate', async (req, res, next) => {
  try {
    await query('UPDATE models SET active = false WHERE active');
    await audit(req, 'model.deactivate');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- activity log (researcher actions only; no personal data) -----------------
research.get('/activity', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT a.id, a.at, a.action, a.target, u.display_name AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.action LIKE 'research.%' OR a.action LIKE 'training.%' OR a.action LIKE 'model.%' ORDER BY a.id DESC LIMIT 100`);
    res.json({ events: rows });
  } catch (e) { next(e); }
});
