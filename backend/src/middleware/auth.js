const jwt = require('jsonwebtoken');
const { Account } = require('../models');

// JWT access-token middleware for host/admin accounts — identical conventions to
// the Glosan template. The token carries { id, roles, tv }; `id` is the Account
// _id and `tv` is the tokenVersion at issuance.

const decodeToken = (token) => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  return { id: decoded.id, roles: decoded.roles || ['user'], tv: decoded.tv || 0 };
};

// A token is revoked the moment its tokenVersion falls behind the account's
// (password reset, "sign out everywhere", role change) — or the account is gone.
//
// This check runs on EVERY authed request, and twice on requireAuth routes
// (global optionalAuth already validated once). A short-TTL cache of
// accountId -> tokenVersion turns the repeat lookups into memory reads. Revocation
// stays INSTANT because every tokenVersion bump calls invalidateAccount() (see the
// three callers in routes/auth.js + routes/maintenance.js); the TTL only bounds
// how long a since-deleted account's rejection is remembered. Single-process, so
// the cache is authoritative; revisit if we scale to multiple instances.
const TOKEN_CACHE_TTL_MS = 10_000;
const tokenVersionCache = new Map(); // id(str) -> { tv: number|null, expires: ms }

const invalidateAccount = (id) => {
  tokenVersionCache.delete(String(id));
};

const tokenStillValid = async (decoded) => {
  const id = String(decoded.id);
  const presented = decoded.tv || 0;
  const cached = tokenVersionCache.get(id);
  if (cached && cached.expires > Date.now()) {
    return cached.tv !== null && cached.tv === presented;
  }
  const acct = await Account.findById(decoded.id).select('tokenVersion').lean();
  const tv = acct ? acct.tokenVersion || 0 : null; // null = account gone
  // Cheap unbounded-growth guard for a long-lived process.
  if (tokenVersionCache.size > 5000) tokenVersionCache.clear();
  tokenVersionCache.set(id, { tv, expires: Date.now() + TOKEN_CACHE_TTL_MS });
  return tv !== null && tv === presented;
};

const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = decodeToken(authHeader.substring(7));
    if (!(await tokenStillValid(decoded))) {
      return res.status(401).json({ error: 'Session expired — please log in again' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// For routes a host OR an anonymous player can hit (e.g. GET /events/:id which
// computes canManage): sets req.user = null instead of 401 when no valid token.
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  try {
    const decoded = decodeToken(authHeader.substring(7));
    req.user = (await tokenStillValid(decoded)) ? decoded : null;
  } catch {
    req.user = null;
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!req.user.roles.includes('admin')) {
    return res.status(403).json({ error: 'Admin role required' });
  }
  next();
};

module.exports = {
  requireAuth, optionalAuth, requireAdmin, invalidateAccount,
};
