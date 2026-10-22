import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileTypeFromFile } from 'file-type';
import { z } from 'zod';
import { withIdentity } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { uploadLimiter } from '../middleware/limits.js';
import { encryptField, decryptField, encryptFileBuffer, decryptFileBuffer, sha256 } from '../security/crypto.js';
import { putCiphertext, getCiphertext, removeCiphertext } from '../services/vault.js';
import { validCoords, cellFor } from '../services/geo.js';
import { identify } from '../services/inference.js';
import { badgesFor, levelOf, POINTS } from '../services/progress.js';
import { audit } from '../services/audit.js';
import { speciesDto, mediaDto, recountSpecies } from '../services/dto.js';

export const observations = Router();
observations.use(requireAuth);

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);

const upload = multer({
  dest: os.tmpdir() + '/bioquest-incoming',
  limits: { fileSize: config.limits.videoBytes, files: config.limits.filesPerObservation, fields: 12, fieldSize: 4096 },
  fileFilter: (req, file, cb) => cb(null, IMAGE_TYPES.has(file.mimetype) || VIDEO_TYPES.has(file.mimetype))
});

const fields = z.object({
  lat: z.coerce.number().optional(), lon: z.coerce.number().optional(),
  notes: z.string().trim().max(500).optional(),
  placeLabel: z.string().trim().max(80).optional(),
  consentResearch: z.enum(['true', 'false']).optional()
});

async function obsDto(db, row) {
  const media = await db.query('SELECT id, kind, mime FROM media WHERE observation_id = $1 ORDER BY created_at', [row.id]);
  return {
    id: row.id, status: row.status, userChoice: row.user_choice,
    species: row.species_slug ? speciesDto(row, 'sp_') : null,
    ai: row.ai_slug ? { species: speciesDto(row, 'ai_'), confidence: row.ai_confidence } : null,
    notes: row.notes_enc ? decryptField(row.notes_enc, 'observations.notes') : '',
    placeLabel: row.place_label, cell: row.cell_lat == null ? null : { lat: row.cell_lat, lon: row.cell_lon },
    shareForResearch: row.consent_research, points: row.points_awarded, isFirst: row.is_first,
    observedAt: row.observed_at, media: media.rows.map(mediaDto)
  };
}

const OBS_SQL = `
  SELECT o.*, sp.slug AS sp_slug, sp.common_name AS sp_common_name, sp.scientific_name AS sp_scientific_name, sp.kind AS sp_kind,
         sp.iucn_code AS sp_iucn_code, sp.status_label AS sp_status_label, sp.description AS sp_description,
         sp.habitat AS sp_habitat, sp.why_it_matters AS sp_why_it_matters, sp.color_a AS sp_color_a, sp.color_b AS sp_color_b,
         ai.slug AS ai_slug, ai.common_name AS ai_common_name, ai.scientific_name AS ai_scientific_name, ai.kind AS ai_kind,
         ai.iucn_code AS ai_iucn_code, ai.status_label AS ai_status_label, ai.description AS ai_description,
         ai.habitat AS ai_habitat, ai.why_it_matters AS ai_why_it_matters, ai.color_a AS ai_color_a, ai.color_b AS ai_color_b
    FROM observations o
    LEFT JOIN species sp ON sp.id = o.species_id
    LEFT JOIN species ai ON ai.id = o.ai_species_id`;

// ---- create (photo/video upload) --------------------------------------------
observations.post('/', uploadLimiter, upload.array('files', config.limits.filesPerObservation), async (req, res, next) => {
  const tmp = (req.files ?? []).map((f) => f.path);
  const written = [];
  try {
    const f = fields.parse(req.body);
    if (!req.files?.length) return res.status(400).json({ error: 'Choose a photo or video of a plant or animal.' });

    // 1. Validate by real content (magic bytes), never by file name or the browser's claim.
    const prepared = [];
    for (const file of req.files) {
      const real = await fileTypeFromFile(file.path);
      if (!real) return res.status(400).json({ error: 'That file type is not supported. Use JPG, PNG, WebP, MP4 or WebM.' });
      if (IMAGE_TYPES.has(real.mime)) {
        if (file.size > config.limits.imageBytes) return res.status(400).json({ error: 'Photos can be up to 12 MB.' });
        // Re-encode: removes EXIF (including hidden GPS), neutralises polyglot/malformed files, limits size.
        const pipeline = sharp(file.path, { limitInputPixels: 60e6, failOn: 'error' }).rotate();
        const main = await pipeline.clone().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
        const thumb = await pipeline.clone().resize({ width: 480, height: 480, fit: 'cover' }).jpeg({ quality: 78 }).toBuffer();
        prepared.push({ kind: 'image', mime: 'image/jpeg', main, thumb });
      } else if (VIDEO_TYPES.has(real.mime)) {
        prepared.push({ kind: 'video', mime: real.mime, main: await fs.readFile(file.path), thumb: null });
      } else {
        return res.status(400).json({ error: 'That file type is not supported. Use JPG, PNG, WebP, MP4 or WebM.' });
      }
    }
    const firstImage = prepared.find((p) => p.kind === 'image');
    if (!firstImage) return res.status(400).json({ error: 'Include at least one photo so researchers can verify the sighting.' });

    // 2. Location: exact value encrypted, only a coarse grid cell kept in clear.
    let geo = null;
    if (f.lat != null && f.lon != null && validCoords(f.lat, f.lon)) geo = { lat: f.lat, lon: f.lon };

    // 3. Ask the active model (if any) what it sees.
    const ai = await identify(firstImage.main);

    const user = req.auth.user;
    const consent = f.consentResearch ? f.consentResearch === 'true' : user.consentResearch;

    const dto = await withIdentity(user, async (db) => {
      let aiSpecies = null;
      if (ai.top.length) {
        const { rows } = await db.query('SELECT id, slug, sensitive FROM species WHERE slug = ANY($1)', [ai.top.map((t) => t.slug)]);
        aiSpecies = rows;
      }
      const top1 = ai.top[0] && aiSpecies.find((s) => s.slug === ai.top[0].slug);
      const sensitive = !!top1?.sensitive;
      const cell = geo ? cellFor(geo.lat, geo.lon, sensitive) : { cell_lat: null, cell_lon: null };
      const { rows: [o] } = await db.query(
        `INSERT INTO observations (user_id, ai_species_id, ai_confidence, ai_model_id, notes_enc, place_label, geo_enc,
                                   cell_lat, cell_lon, consent_research)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [user.id, top1?.id ?? null, ai.top[0]?.confidence ?? null, ai.modelId,
         f.notes ? encryptField(f.notes, 'observations.notes') : null, f.placeLabel || null,
         geo ? encryptField(JSON.stringify(geo), 'observations.geo') : null, cell.cell_lat, cell.cell_lon, consent]
      );
      for (const p of prepared) {
        const enc = encryptFileBuffer(p.main);
        const key = await putCiphertext(enc.ct); written.push(key);
        let thumbKey = null, thumbEnc = null;
        if (p.thumb) { thumbEnc = encryptFileBuffer(p.thumb); thumbKey = await putCiphertext(thumbEnc.ct); written.push(thumbKey); }
        await db.query(
          `INSERT INTO media (observation_id, owner_id, kind, mime, bytes, plain_sha256, storage_key, thumb_key,
                              dek_wrapped, thumb_dek_wrapped, kek_version, iv, auth_tag, thumb_iv, thumb_tag)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [o.id, user.id, p.kind, p.mime, p.main.length, sha256(p.main), key, thumbKey, enc.dekWrapped,
           thumbEnc?.dekWrapped ?? null, enc.kekVersion, enc.iv, enc.tag, thumbEnc?.iv ?? null, thumbEnc?.tag ?? null]
        );
      }
      const { rows: [row] } = await db.query(OBS_SQL + ' WHERE o.id = $1', [o.id]);
      return { observation: await obsDto(db, row), suggestions: await suggestionDtos(db, ai.top) };
    });
    await audit(req, 'observation.create', { target: dto.observation.id, meta: { files: prepared.length, shared: consent } });
    res.status(201).json(dto);
  } catch (e) {
    await Promise.all(written.map((k) => removeCiphertext(k).catch(() => {})));
    next(e);
  } finally {
    await Promise.all(tmp.map((p) => fs.rm(p, { force: true })));
  }
});

async function suggestionDtos(db, top) {
  if (!top.length) return [];
  const { rows } = await db.query('SELECT * FROM species WHERE slug = ANY($1)', [top.map((t) => t.slug)]);
  return top.map((t) => ({ confidence: t.confidence, species: speciesDto(rows.find((r) => r.slug === t.slug)) })).filter((s) => s.species);
}

// ---- choose / confirm the identification -------------------------------------
observations.post('/:id/identify', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const body = z.object({
      choice: z.enum(['accept_ai', 'manual', 'unsure']),
      speciesSlug: z.string().max(80).optional()
    }).strict().parse(req.body);
    const user = req.auth.user;

    const out = await withIdentity(user, async (db) => {
      const { rows: [o] } = await db.query('SELECT * FROM observations WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, user.id]);
      if (!o) return { notFound: true };
      if (o.user_choice !== 'none') return { conflict: true };

      let speciesId = null;
      if (body.choice === 'accept_ai') {
        if (!o.ai_species_id) return { bad: 'There is no AI suggestion to accept.' };
        speciesId = o.ai_species_id;
      } else if (body.choice === 'manual') {
        const { rows: [s] } = await db.query('SELECT id FROM species WHERE slug = $1', [body.speciesSlug ?? '']);
        if (!s) return { bad: 'Pick a species from the list.' };
        speciesId = s.id;
      }
      const before = await badgesFor(db, user.id);
      let first = false;
      if (speciesId) {
        const { rowCount } = await db.query(
          `SELECT 1 FROM observations WHERE user_id = $1 AND species_id = $2 AND user_choice <> 'none' AND id <> $3 LIMIT 1`, [user.id, speciesId, id]);
        first = rowCount === 0;
      }
      const pts = speciesId ? POINTS.base + (first ? POINTS.firstDiscovery : 0) : 20;
      await db.query(
        `UPDATE observations SET species_id = $2, user_choice = $3, is_first = $4, points_awarded = $5 WHERE id = $1`,
        [id, speciesId, body.choice === 'accept_ai' ? 'accepted_ai' : body.choice, first, pts]);
      const { rows: [u] } = await db.query(
        `UPDATE users SET points = points + $2, observation_count = observation_count + 1,
                species_found = species_found + $3 WHERE id = $1 RETURNING points, species_found, observation_count`,
        [user.id, pts, first ? 1 : 0]);
      const after = await badgesFor(db, user.id);
      const unlocked = after.filter((b, i) => b.earned && !before[i].earned).map((b) => b.name);
      const { rows: [row] } = await db.query(OBS_SQL + ' WHERE o.id = $1', [id]);
      return { observation: await obsDto(db, row), pointsAwarded: pts, isFirst: first, unlocked,
               totals: { points: u.points, level: levelOf(u.points), xp: u.points % 1000, species: u.species_found, observations: u.observation_count } };
    });
    if (out.notFound) return res.status(404).json({ error: 'Observation not found.' });
    if (out.conflict) return res.status(409).json({ error: 'You already confirmed this observation.' });
    if (out.bad) return res.status(400).json({ error: out.bad });
    await audit(req, 'observation.identify', { target: id, meta: { choice: body.choice } });
    res.json(out);
  } catch (e) { next(e); }
});

// ---- list / read -----------------------------------------------------------
observations.get('/', async (req, res, next) => {
  try {
    const rows = await withIdentity(req.auth.user, async (db) => {
      const { rows } = await db.query(OBS_SQL + ` WHERE o.user_id = $1 ORDER BY o.observed_at DESC LIMIT 200`, [req.auth.user.id]);
      return Promise.all(rows.map((r) => obsDto(db, r)));
    });
    res.json({ observations: rows });
  } catch (e) { next(e); }
});

observations.get('/:id', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const dto = await withIdentity(req.auth.user, async (db) => {
      const { rows: [r] } = await db.query(OBS_SQL + ' WHERE o.id = $1 AND o.user_id = $2', [id, req.auth.user.id]);
      return r ? obsDto(db, r) : null;
    });
    if (!dto) return res.status(404).json({ error: 'Observation not found.' });
    res.json({ observation: dto });
  } catch (e) { next(e); }
});

// ---- delete (removes database rows AND encrypted files) ---------------------
observations.delete('/:id', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const keys = await withIdentity(req.auth.user, async (db) => {
      const { rows } = await db.query('SELECT storage_key, thumb_key FROM media WHERE observation_id = $1 AND owner_id = $2', [id, req.auth.user.id]);
      const del = await db.query('DELETE FROM observations WHERE id = $1 AND user_id = $2', [id, req.auth.user.id]);
      if (!del.rowCount) return null;
      await recountSpecies(db, req.auth.user.id);
      return rows.flatMap((r) => [r.storage_key, r.thumb_key]).filter(Boolean);
    });
    if (!keys) return res.status(404).json({ error: 'Observation not found.' });
    await Promise.all(keys.map(removeCiphertext));
    await audit(req, 'observation.delete', { target: id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- stream decrypted media (owner or researcher, enforced by Row-Level Security) ---
export async function sendMedia(req, res, next) {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const thumb = req.params.variant === 'thumb';
    const m = await withIdentity(req.auth.user, async (db) => (await db.query('SELECT * FROM media WHERE id = $1', [id])).rows[0]);
    if (!m || (thumb && !m.thumb_key)) return res.status(404).json({ error: 'Not found.' });

    const ct = await getCiphertext(thumb ? m.thumb_key : m.storage_key);
    const plain = decryptFileBuffer(ct, {
      dekWrapped: thumb ? m.thumb_dek_wrapped : m.dek_wrapped, kekVersion: m.kek_version,
      iv: thumb ? m.thumb_iv : m.iv, tag: thumb ? m.thumb_tag : m.auth_tag
    });
    if (req.auth.user.role === 'researcher') await audit(req, 'media.view', { target: id });

    res.setHeader('Content-Type', thumb ? 'image/jpeg' : m.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.get('range') ?? '');
    if (range && m.kind === 'video' && !thumb) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = Math.min(range[2] ? Number(range[2]) : plain.length - 1, plain.length - 1);
      if (start > end) return res.status(416).end();
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${plain.length}`);
      res.setHeader('Content-Length', end - start + 1);
      return res.end(plain.subarray(start, end + 1));
    }
    res.setHeader('Content-Length', plain.length);
    res.end(plain);
  } catch (e) { next(e); }
}
