const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const { uploadsDir } = require('./config/paths');
const { accessGate } = require('./middleware/accessGate');
const { optionalAuth } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/error');

// Ensure every model/schema is registered up front.
require('./models');

// Route modules.
const healthRoute = require('./routes/health');
const bootstrapRoute = require('./routes/bootstrap');
const authRoute = require('./routes/auth');
const usersRoute = require('./routes/users');
const eventsRoute = require('./routes/events');
const eventSocialRoute = require('./routes/eventSocial');
const activitiesRoute = require('./routes/activities');
const questionsRoute = require('./routes/questions');
const participantsRoute = require('./routes/participants');
const gameplayRoute = require('./routes/gameplay');
const bracketRoute = require('./routes/bracket');
const gamesRoute = require('./routes/games');
const musicRoute = require('./routes/music');
const simulationRoute = require('./routes/simulation');
const spotifyRoute = require('./routes/spotify');
const libraryRoute = require('./routes/library');
const maintenanceRoute = require('./routes/maintenance');

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

// Populate req.user (or null) for every request so the event/activity
// authorization helpers can read the host account on any route. Routes that
// must *require* a login still use requireAuth/requireAdmin on top.
app.use(optionalAuth);

// User-uploaded images (photo wall, event/activity images).
app.use('/uploads', express.static(uploadsDir, { maxAge: '7d', fallthrough: true }));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/health', healthRoute);
app.use('/api/bootstrap', bootstrapRoute);
app.use('/api/auth', authRoute);
app.use('/api/users', usersRoute);
app.use('/api/spotify', spotifyRoute);
app.use('/api/admin', maintenanceRoute);

// Event-scoped routers (share the /api/events base; distinct subpaths).
app.use('/api/events', eventsRoute);
app.use('/api/events', eventSocialRoute);

// Activity-scoped routers (share the /api/activities base; distinct subpaths).
app.use('/api/activities', activitiesRoute);
app.use('/api/activities', participantsRoute);
app.use('/api/activities', questionsRoute);
app.use('/api/activities', gameplayRoute);
app.use('/api/activities', bracketRoute);
app.use('/api/activities', gamesRoute);
app.use('/api/activities', musicRoute);
app.use('/api/activities', simulationRoute);

// Question library (/api/question-library/*, /api/activities/:id/questions/from-library).
app.use('/api', libraryRoute);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
