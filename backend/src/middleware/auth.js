const jwt = require('jsonwebtoken');

// JWT access-token middleware for host/admin accounts — identical conventions to
// the Glosan template. The token carries { id, roles }; `id` is the Account _id.

const decodeToken = (token) => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  const roles = decoded.roles || ['user'];
  return { id: decoded.id, roles };
};

const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    req.user = decodeToken(authHeader.substring(7));
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
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  try {
    req.user = decodeToken(authHeader.substring(7));
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
