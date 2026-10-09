// Runs the active species-identification model (ONNX) on an uploaded photo.
// If no model has been trained and activated yet, or onnxruntime is not
// installed, it simply returns no suggestions and the app falls back to
// manual identification + researcher review.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { query } from '../db.js';
import { config } from '../config.js';

let ort = null;
try { ort = await import('onnxruntime-node'); } catch { /* optional dependency */ }

let cache = { at: 0, model: null, session: null };
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

async function loadActive() {
  if (Date.now() - cache.at < 30_000) return cache;
  cache.at = Date.now();
  const { rows: [m] } = await query('SELECT id, onnx_path, labels, sha256, metrics FROM models WHERE active LIMIT 1');
  if (!m) { cache.model = null; cache.session = null; return cache; }
  if (cache.model?.id === m.id && cache.session) return cache;
  try {
    const file = path.resolve(config.modelDir, path.basename(m.onnx_path));
    const bytes = await fs.readFile(file);
    // Refuse to load a model file that was modified after training.
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== m.sha256) throw new Error('model checksum mismatch');
    cache.session = await ort.InferenceSession.create(bytes);
    cache.model = m;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'model_load_failed', err: e.message }));
    cache.model = null; cache.session = null;
  }
  return cache;
}

export const inferenceAvailable = async () => !!ort && !!(await loadActive()).session;

/** @returns {Promise<{modelId:string|null, top:Array<{slug:string, confidence:number}>}>} */
export async function identify(imageBuffer) {
  if (!ort) return { modelId: null, top: [] };
  const { model, session } = await loadActive();
  if (!session) return { modelId: null, top: [] };
  try {
    const size = model.metrics?.image_size || 224;
    const { data } = await sharp(imageBuffer).resize(size, size, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const plane = size * size;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) input[c * plane + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    const tensor = new ort.Tensor('float32', input, [1, 3, size, size]);
    const out = await session.run({ [session.inputNames[0]]: tensor });
    const logits = Array.from(out[session.outputNames[0]].data);
    const mx = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - mx));
    const sum = exps.reduce((a, b) => a + b, 0);
    const top = exps.map((e, i) => ({ slug: model.labels[i], confidence: e / sum }))
      .sort((a, b) => b.confidence - a.confidence).slice(0, 3);
    return { modelId: model.id, top };
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'inference_failed', err: e.message }));
    return { modelId: null, top: [] };
  }
}
