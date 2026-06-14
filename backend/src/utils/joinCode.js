const crypto = require('crypto');

// Short, human-friendly join codes (rundan's JoinCodeGenerator). Uppercase,
// no ambiguous characters (no 0/O/1/I), so they're easy to read aloud and type
// on a phone. Used for both Event.joinCode and Activity.joinCode.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(length = 5) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

// Generate a code unique within the given model's `joinCode` field. Retries on
// the rare collision; widens length after several attempts as a safety valve.
async function uniqueJoinCode(Model, length = 5) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = randomCode(attempt < 8 ? length : length + 1);
    // eslint-disable-next-line no-await-in-loop
    const exists = await Model.exists({ joinCode: code });
    if (!exists) return code;
  }
  // Extremely unlikely fallback — timestamp-suffixed.
  return `${randomCode(length)}${Date.now().toString(36).slice(-2).toUpperCase()}`;
}

module.exports = { randomCode, uniqueJoinCode, ALPHABET };
