const env = require('../config/env');
const { timingSafeEqualStr } = require('../utils/security');

// Optional shared site gate — the MERN port of rundan's AccessCodeMiddleware.
// Disabled unless ACCESS_CODE is set (open dev/default). When enabled, every
// /api route except the public allowlist requires the code via the
// `x-rundan-access` header (or `?access_token=` for transports that can't set
// headers). The JWT `Authorization: Bearer` header is NOT used here — that now
// carries account tokens, a separate concern.
const PUBLIC = [/^\/api\/health\b/, /^\/api\/bootstrap\b/];

function accessGate(req, res, next) {
  if (!env.requiresAccessCode) return next();
  if (!req.path.startsWith('/api')) return next();
  if (PUBLIC.some((re) => re.test(req.path))) return next();

  const provided = req.headers['x-rundan-access'] || req.query.access_token;
  if (timingSafeEqualStr(provided, env.accessCode)) return next();
  return res.status(401).json({ error: 'Invalid or missing access code.' });
}

// Socket.IO handshake variant — validate the access code from the handshake when
// the gate is enabled. Returns true if allowed.
function socketAccessAllowed(handshake) {
  if (!env.requiresAccessCode) return true;
  const provided = handshake.auth?.accessCode || handshake.query?.access_token;
  return timingSafeEqualStr(provided, env.accessCode);
}

module.exports = { accessGate, socketAccessAllowed };
