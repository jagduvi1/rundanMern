// WordGameService — longest-word game (port of
// Rundan.Server/Services/WordGameService.cs).
//
// Each team gets a fixed set of 20 letter tiles (deterministic from the
// participant id, stable across reloads), may open up to 10, and submits the
// longest word buildable from the OPENED letters within the time limit. The
// word's length is the score (higher wins), stored as one ScoreEntry. No
// dictionary check — only length matters.

const { ScoreEntry } = require('../models');
const { RuleViolation } = require('../middleware/error');

const TILE_COUNT = 20;
const MAX_OPEN = 10;
const SECONDS = 60;

// Vowel-heavy bag so words are formable; weighting by repetition. Copied verbatim
// from the .NET source — index positions must not change (the RNG indexes it).
const BAG = 'AAAAAAEEEEEEEIIIIIOOOOOUUUNNNNTTTTRRRRSSSSLLLLDDDGGGBBCCMMPPFFHHVVKJ';

// ── Deterministic tiles ───────────────────────────────────────────────────────
//
// The .NET service seeds `new Random(participantId)` and draws 20 letters. Mongo
// participant ids are ObjectIds, not ints, so we (a) derive a stable 32-bit
// integer surrogate from the ObjectId, and (b) reimplement .NET's legacy
// `System.Random(int Seed)` generator. Result: the same 20 tiles every time for
// a given participant id (the only externally observable contract), with no extra
// persistence or schema. The exact letters differ from a hypothetical legacy .NET
// deployment (different seed integer), but this is a greenfield port — stability
// is what matters, and it's guaranteed by the deterministic id→seed→RNG chain.

// Stable 32-bit non-negative integer derived from an ObjectId (or any id). Parses
// the last 8 hex chars of the 24-hex string; falls back to a char hash otherwise.
function seedFromId(id) {
  const s = id == null ? '' : (typeof id === 'object' && id._id !== undefined
    ? String(id._id)
    : String(id));
  if (/^[0-9a-fA-F]{24}$/.test(s)) {
    // Last 8 hex chars → 32-bit unsigned.
    return Number.parseInt(s.slice(16), 16) >>> 0;
  }
  // Fallback: FNV-1a-ish 32-bit hash of the string.
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// A faithful reimplementation of .NET Framework's `System.Random` legacy
// subtractive (Knuth) generator, sufficient for `Next(maxValue)` over a small
// range. Reproduces the seeding ritual and `InternalSample`/`Sample` exactly so
// the draw is deterministic per seed.
class DotNetRandom {
  constructor(seed) {
    this.seedArray = new Array(56).fill(0);
    const MBIG = 2147483647; // int.MaxValue
    // Subtraction can overflow 32-bit; emulate .NET's `int` wraparound.
    const toInt32 = (n) => n | 0;

    const subtraction = seed === -2147483648 ? 2147483647 : Math.abs(seed);
    let mj = toInt32(161803398 - subtraction);
    this.seedArray[55] = mj;
    let mk = 1;
    for (let i = 1; i < 55; i += 1) {
      const ii = (21 * i) % 55;
      this.seedArray[ii] = mk;
      mk = toInt32(mj - mk);
      if (mk < 0) mk += MBIG;
      mj = this.seedArray[ii];
    }
    for (let k = 1; k < 5; k += 1) {
      for (let i = 1; i < 56; i += 1) {
        this.seedArray[i] = toInt32(this.seedArray[i] - this.seedArray[1 + ((i + 30) % 55)]);
        if (this.seedArray[i] < 0) this.seedArray[i] += MBIG;
      }
    }
    this.inext = 0;
    this.inextp = 21;
  }

  // Core sample: returns an int in [0, int.MaxValue).
  internalSample() {
    const MBIG = 2147483647;
    let { inext, inextp } = this;
    inext += 1;
    if (inext >= 56) inext = 1;
    inextp += 1;
    if (inextp >= 56) inextp = 1;
    let retVal = this.seedArray[inext] - this.seedArray[inextp];
    if (retVal === MBIG) retVal -= 1;
    if (retVal < 0) retVal += MBIG;
    this.seedArray[inext] = retVal;
    this.inext = inext;
    this.inextp = inextp;
    return retVal;
  }

  // [0,1) double.
  sample() {
    return this.internalSample() * (1.0 / 2147483647);
  }

  // [0, maxValue) int (maxValue assumed positive and small — as used here).
  next(maxValue) {
    return Math.floor(this.sample() * maxValue);
  }
}

// The 20 deterministic tiles for a participant id (array of single-char strings).
function tiles(participantId) {
  const rng = new DotNetRandom(seedFromId(participantId));
  const out = new Array(TILE_COUNT);
  for (let i = 0; i < TILE_COUNT; i += 1) {
    out[i] = BAG[rng.next(BAG.length)];
  }
  return out;
}

// ── Read ──────────────────────────────────────────────────────────────────────

// Build the WordGameDto for a participant. `latest` is the most recent ScoreEntry
// (max id) for this team in this activity, if any.
function buildDto(participantId, latest) {
  return {
    tiles: tiles(participantId),
    maxOpen: MAX_OPEN,
    seconds: SECONDS,
    submittedWord: latest ? (latest.note ?? null) : null,
    submittedScore: latest ? Math.trunc(latest.points) : null,
  };
}

/**
 * Returns the WordGameDto for a participant: their 20 tiles, the rules, and their
 * latest submitted word/score (if any).
 * @param {object} activity A loaded Activity Mongoose doc (only _id is used).
 * @param {object} participant A loaded Participant Mongoose doc.
 * @returns {Promise<{tiles:string[], maxOpen:number, seconds:number,
 *   submittedWord:(string|null), submittedScore:(number|null)}>}
 */
async function getWordGame(activity, participant) {
  // Latest entry = max id → ObjectId is monotonic, so sort by _id desc.
  const latest = await ScoreEntry.findOne({
    activityId: activity._id,
    participantId: participant._id,
  }).sort({ _id: -1 });

  return buildDto(participant._id, latest);
}

/**
 * Validates a submitted word against the opened tiles and records it as the
 * team's single score line (length = score). Replaces any earlier submission.
 * @param {object} activity A loaded Activity Mongoose doc.
 * @param {object} participant A loaded Participant Mongoose doc.
 * @param {object} req
 * @param {number[]} req.openedIndices Tile indices the team opened (≤10 honoured).
 * @param {string} req.word The submitted word.
 * @returns {Promise<{tiles:string[], maxOpen:number, seconds:number,
 *   submittedWord:string, submittedScore:number}>}
 */
async function submitWord(activity, participant, req = {}) {
  const ts = tiles(participant._id);

  // Allowed letters: the (≤10) DISTINCT opened tiles, first 10 in input order.
  const indices = Array.isArray(req.openedIndices) ? req.openedIndices : [];
  const seenIdx = new Set();
  const opened = [];
  for (const i of indices) {
    if (i >= 0 && i < TILE_COUNT && !seenIdx.has(i)) {
      seenIdx.add(i);
      if (opened.length < MAX_OPEN) opened.push(ts[i]);
    }
  }

  const word = (req.word ?? '').trim().toUpperCase();
  if (word.length === 0) throw new RuleViolation('Enter a word.');

  // Every letter of the word must come from an opened tile (each tile used once).
  const available = new Map();
  for (const c of opened) available.set(c, (available.get(c) || 0) + 1);
  for (const c of word) {
    const n = available.get(c) || 0;
    if (n === 0) throw new RuleViolation("Your word uses letters you haven't opened.");
    available.set(c, n - 1);
  }

  // One submission per team — replace any earlier word.
  await ScoreEntry.deleteMany({ activityId: activity._id, participantId: participant._id });
  await ScoreEntry.create({
    activityId: activity._id,
    participantId: participant._id,
    round: 1,
    points: word.length,
    note: word,
    recordedUtc: new Date(),
  });

  return {
    tiles: ts,
    maxOpen: MAX_OPEN,
    seconds: SECONDS,
    submittedWord: word,
    submittedScore: word.length,
  };
}

module.exports = {
  getWordGame,
  submitWord,
  // Exposed for tests / reuse.
  tiles,
  TILE_COUNT,
  MAX_OPEN,
  SECONDS,
};
