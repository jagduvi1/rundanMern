const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const { uploadsDir } = require('./config/paths');
const { accessGate } = require('./middleware/accessGate');
const { notFound, errorHandler } = require('./middleware/error');

// Ensure every model/schema is registered up front.
require('./models');

// Route modules (mounted incrementally as the port grows).
const healthRoute = require('./routes/health');
const bootstrapRoute = require('./routes/bootstrap');
const authRoute = require('./routes/auth');

const app = express();
app.set('trust proxy', 2);

app.use(
  helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // Allow images we serve from /uploads to be embedded cross-origin by the SPA.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], imgSrc: ["'self'", 'data:'], frameAncestors: ["'none'"] },
    },
  })
);

app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '256kb' }));

// CORS — supports a single or comma-separated FRONTEND_URL. Custom rundan
// headers must be allow-listed so the browser may send them cross-origin.
const corsOrigin = (() => {
  const raw = env.frontendUrl;
  if (!raw) return env.isProd ? false : 'http://localhost:3000';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length === 1 ? list[0] : list;
})();
if (env.isProd && !env.frontendUrl) {
  console.warn('[security] FRONTEND_URL is not set — CORS will block cross-origin requests in production');
}
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Rundan-Access',
      'X-Rundan-Participant',
      'X-Rundan-Member',
    ],
  })
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many requests, please try again later' }),
});
app.use('/api/', apiLimiter);

// Optional shared site gate (no-op unless ACCESS_CODE is set).
app.use(accessGate);

// User-uploaded images (photo wall, event/activity images).
app.use('/uploads', express.static(uploadsDir, { maxAge: '7d', fallthrough: true }));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/health', healthRoute);
app.use('/api/bootstrap', bootstrapRoute);
app.use('/api/auth', authRoute);
// NOTE: users, events, activities, participants, questions, gameplay, bracket,
// mappin, memory, music, spotify, simulation, wordgame, library, maintenance,
// push, chat — mounted here as each route module lands.

app.use(notFound);
app.use(errorHandler);

module.exports = app;
