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

// Generate a code unique across the given model(s)' `joinCode` field. Pass a
// single Mongoose model or an ARRAY of models — join codes must be unique across
// BOTH events and activities (a player types one code; the lookup tries events
// first, so a shared code would shadow the other), matching the .NET
// JoinCodeGenerator. Retries on the rare collision; widens length as a safety valve.
async function uniqueJoinCode(modelOrModels, length = 5) {
  const models = Array.isArray(modelOrModels) ? modelOrModels : [modelOrModels];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = randomCode(attempt < 8 ? length : length + 1);
    // eslint-disable-next-line no-await-in-loop
    const taken = await Promise.all(models.map((M) => M.exists({ joinCode: code })));
    if (!taken.some(Boolean)) return code;
  }
  // Extremely unlikely fallback — timestamp-suffixed.
  return `${randomCode(length)}${Date.now().toString(36).slice(-2).toUpperCase()}`;
}

module.exports = { randomCode, uniqueJoinCode, ALPHABET };
