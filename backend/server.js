require('dotenv').config();
const env = require('./src/config/env');

// Fail fast on a missing/weak JWT secret (Glosan-style guard).
if (!env.jwtSecret) {
  console.error('FATAL: Missing required environment variable: JWT_SECRET');
  process.exit(1);
}
if (env.jwtSecret.length < 32) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters long.');
  process.exit(1);
}
if (/change[-_]?me|placeholder|example|please[-_]?change/i.test(env.jwtSecret)) {
  console.error('FATAL: JWT_SECRET looks like an example placeholder. Generate a real random secret (e.g. `openssl rand -hex 64`).');
  process.exit(1);
}

// Production hardening — warn (never exit) on insecure-by-default settings.
if (env.isProd && env.seedCode === 'CALLE') {
  console.warn('[security] SEED_CODE is the default "CALLE" — the destructive clean-and-seed confirmation code is public. Set SEED_CODE to a private value.');
}
if (env.isProd && !env.requiresAccessCode) {
  console.warn('[security] No ACCESS_CODE set — registration is open and the FIRST account to register becomes super-admin. Set ACCESS_CODE, or register the host account immediately after deploy.');
}

const http = require('http');
const fs = require('fs');
const app = require('./src/app');
const connectDB = require('./src/config/db');
const { initSockets } = require('./src/socket');
const { uploadsDir } = require('./src/config/paths');

fs.mkdirSync(uploadsDir, { recursive: true });

// Web Push (optional) — configure VAPID once if keys are present.
if (env.hasWebPush) {
  try {
    // eslint-disable-next-line global-require
    require('web-push').setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
    console.log('Web Push configured');
  } catch (e) {
    console.error('Web Push setup failed:', e.message);
  }
}

const PORT = env.port;

connectDB().then(async () => {
  // Seed the question library on first run (idempotent — skipped if non-empty).
  try {
    // eslint-disable-next-line global-require
    const seeder = require('./src/services/librarySeeder');
    if (seeder.seedIfEmpty) await seeder.seedIfEmpty();
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') console.error('Library seed failed:', e.message);
  }

  // Optional demo data.
  if (env.seedOnStartup) {
    try {
      // eslint-disable-next-line global-require
      const ds = require('./src/services/dataSeeder');
      if (ds.seedIfEmpty) await ds.seedIfEmpty();
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') console.error('Demo seed failed:', e.message);
    }
  }

  const server = http.createServer(app);
  initSockets(server);
  server.listen(PORT, () => console.log(`${env.appName} backend running on port ${PORT}`));
});
