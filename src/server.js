import './env.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const app = createApp();
const server = app.listen(config.port, () =>
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port: config.port, env: config.isProd ? 'production' : 'development' })));
server.requestTimeout = 60_000;
server.headersTimeout = 20_000;

// Periodically purge expired sessions.
setInterval(() => pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}), 10 * 60e3).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(async () => { await pool.end(); process.exit(0); }));
}
