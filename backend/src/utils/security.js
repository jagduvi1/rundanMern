const crypto = require('crypto');

// Constant-time string compare — the MERN port of rundan's
// SecurityHelpers.FixedEquals. Both sides are SHA-256-hashed to a fixed 32-byte
// digest first so neither length nor contents leak through timing (a raw
// timingSafeEqual throws/short-circuits on length mismatch). Used only for the
// surviving shared-string secrets (access code, seed code).
function timingSafeEqualStr(provided, expected) {
  if (provided == null || expected == null) return false;
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { timingSafeEqualStr };
