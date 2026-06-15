// Centralised configuration, the MERN equivalent of rundan's `RundanOptions`.
// Reads from process.env (populated by dotenv in server.js) and exposes the
// same computed capability flags the .NET app had (RequiresAccessCode, etc.).

const bool = (v, def = false) => {
  if (v === undefined || v === null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
};

const str = (v) => {
  const s = (v ?? '').toString().trim();
  return s.length ? s : null;
};

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  get isProd() { return this.nodeEnv === 'production'; },

  port: Number(process.env.PORT) || 5000,
  mongoUri: process.env.MONGO_URI || 'mongodb://mongo:27017/rundan',

  // Number of trusted reverse-proxy hops in front of Express, so req.ip + the
  // per-IP rate limiters resolve the real client IP. Cloudflare → Traefik → nginx
  // ⇒ set TRUST_PROXY=3. Default 1 (plain nginx). Accepts a number, a boolean, or
  // an IP/CIDR list (e.g. "loopback, linklocal, uniquelocal").
  get trustProxy() {
    const raw = process.env.TRUST_PROXY;
    if (raw == null || raw === '') return 1;
    const n = Number(raw);
    if (Number.isInteger(n)) return n;
    if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true';
    return raw;
  },

  // Host/admin account auth (Glosan-style JWT).
  jwtSecret: process.env.JWT_SECRET,
  accessTokenExpiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m',

  // Super-admin accounts, by email — a ';'-separated list in ADMIN_EMAILS
  // (e.g. "a@x.se;b@y.se"). Resolved at token issuance, so an account whose
  // email is listed becomes super-admin on its next login with no DB edit. This
  // replaces the old "first account to register becomes admin" rule and is the
  // recovery path if every admin account is removed — just add an email here.
  adminEmails: (process.env.ADMIN_EMAILS || '')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  frontendUrl: str(process.env.FRONTEND_URL),
  appName: process.env.APP_NAME || 'Rundan',

  // Optional shared site gate (credential #1). Empty => open.
  accessCode: str(process.env.ACCESS_CODE),

  // Destructive clean-and-seed confirmation (credential #5).
  seedCode: process.env.SEED_CODE || 'CALLE',
  seedOnStartup: bool(process.env.SEED_ON_STARTUP, false),

  // Spotify (music quiz).
  spotifyClientId: str(process.env.SPOTIFY_CLIENT_ID),
  spotifyClientSecret: str(process.env.SPOTIFY_CLIENT_SECRET),

  // Last.fm (similar-artist distractors).
  lastFmApiKey: str(process.env.LASTFM_API_KEY),

  // Web Push (VAPID).
  vapidPublicKey: str(process.env.VAPID_PUBLIC_KEY),
  vapidPrivateKey: str(process.env.VAPID_PRIVATE_KEY),
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',

  // Transactional email (optional host flows), via Resend.
  resendApiKey: str(process.env.RESEND_API_KEY),
  emailFrom: str(process.env.EMAIL_FROM),

  // Image upload storage.
  uploadsDir:
    str(process.env.UPLOADS_DIR) ||
    (process.env.HOME ? `${process.env.HOME}/data/uploads` : null),

  // ── Computed capability flags (mirror RundanOptions) ───────────────────────
  isAdminEmail(email) {
    return !!email && this.adminEmails.includes(String(email).toLowerCase());
  },
  get requiresAccessCode() { return !!this.accessCode; },
  get hasLastFm() { return !!this.lastFmApiKey; },
  get hasSpotify() { return !!this.spotifyClientId; },
  get hasSpotifyServer() { return !!(this.spotifyClientId && this.spotifyClientSecret); },
  get hasWebPush() { return !!(this.vapidPublicKey && this.vapidPrivateKey); },
  get hasEmail() { return !!this.resendApiKey; },
};

module.exports = env;
