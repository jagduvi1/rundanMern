// Strip MongoDB operator keys ($-prefixed or dotted) from request inputs so a
// crafted JSON body/query can't smuggle query operators into a Mongoose filter
// (NoSQL operator injection). Dependency-free; runs after the body parser.
// Defense-in-depth on top of per-route input coercion.

function scrub(obj, seen) {
  if (!obj || typeof obj !== 'object') return;
  if (seen.has(obj)) return;
  seen.add(obj);
  if (Array.isArray(obj)) {
    obj.forEach((v) => scrub(v, seen));
    return;
  }
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete obj[key];
    } else {
      scrub(obj[key], seen);
    }
  }
}

function mongoSanitize(req, res, next) {
  const seen = new WeakSet();
  scrub(req.body, seen);
  scrub(req.query, seen);
  next();
}

module.exports = mongoSanitize;
