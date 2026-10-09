import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config } from './config.js';
import { securityHeaders, noStore } from './middleware/security.js';
import { loadSession, csrfProtect, requireAuth } from './middleware/auth.js';
import { apiLimiter } from './middleware/limits.js';
import { auth } from './routes/auth.js';
import { me } from './routes/me.js';
import { observations, sendMedia } from './routes/observations.js';
import { game } from './routes/game.js';
import { research } from './routes/research.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');

export function createApp() {
  config.keys; // fail fast if secrets are missing or malformed
  fs.mkdirSync(path.resolve(config.uploadDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(os.tmpdir(), 'bioquest-incoming'), { recursive: true, mode: 0o700 });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  if (config.isProd) {
    app.use((req, res, next) => (req.secure ? next() : res.redirect(308, config.publicOrigin + req.originalUrl)));
  }
  app.use(securityHeaders);

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---- static front end (strict CSP, long cache for versioned assets) ----
  app.use(express.static(pub, { index: false, dotfiles: 'ignore', maxAge: '1h', setHeaders: (res, p) => {
    if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    if (p.endsWith('.woff2')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } }));
  app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));
  app.get('/research', (req, res) => res.sendFile(path.join(pub, 'research.html')));

  // ---- API ----
  const api = express.Router();
  api.use(noStore, apiLimiter, express.json({ limit: '20kb' }), cookieParser(), loadSession, csrfProtect);
  api.use('/auth', auth);
  api.get('/media/:id/:variant?', requireAuth, (req, res, next) =>
    (['thumb', undefined].includes(req.params.variant) ? sendMedia(req, res, next) : res.status(404).json({ error: 'Not found.' })));
  api.use('/me', me);
  api.use('/observations', observations);
  api.use('/research', research);
  api.use('/play', game);
  api.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use('/api', api);

  app.use((req, res) => res.status(404).type('text').send('Not found'));

  // Errors never leak stack traces or SQL to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return res.status(400).json({ error: first?.message && first.message !== 'Invalid input' ? first.message : `Please check "${first?.path?.join('.') || 'your input'}".` });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request.' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That file is too large (photos 12 MB, videos 40 MB).' });
    if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'You can add up to 3 files per observation.' });
    if (err?.message?.includes('Input file') || err?.message?.includes('unsupported image format')) {
      return res.status(400).json({ error: 'We could not read that image. Try another photo.' });
    }
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled', path: req.path, err: err?.message, stack: config.isProd ? undefined : err?.stack }));
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  });
  return app;
}
