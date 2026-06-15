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
// (password reset, "sign out everywhere") — or the account is gone. Looked up
// only when a token is actually presented, so anonymous traffic pays nothing.
const tokenStillValid = async (decoded) => {
  const acct = await Account.findById(decoded.id).select('tokenVersion').lean();
  if (!acct) return false;
  return (acct.tokenVersion || 0) === (decoded.tv || 0);
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

module.exports = { requireAuth, optionalAuth, requireAdmin };
