const crypto = require('crypto');

// Shareable friend codes — 6 chars from an unambiguous alphabet (no 0/O, 1/I,
// no lowercase). 32^6 ≈ 1 billion combinations: easy to read aloud, hard to
// brute-force at our rate limits. Each Account lazily gets one on first request.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(length = 6) {
  let s = '';
  for (let i = 0; i < length; i += 1) s += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return s;
}

async function generateUniqueFriendCode(AccountModel) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = randomCode();
    // eslint-disable-next-line no-await-in-loop
    const exists = await AccountModel.findOne({ friendCode: code }).select('_id').lean();
    if (!exists) return code;
  }
  throw new Error('Failed to generate a unique friend code');
}

module.exports = { randomCode, generateUniqueFriendCode };
