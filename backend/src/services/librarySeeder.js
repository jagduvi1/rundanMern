// LibrarySeeder — seed the question library from the bundled JSON (port of
// Rundan.Server/Services/LibrarySeeder.cs).
//
// Seeds the pre-generated question library (reference data) when it's empty.
// Questions live in `src/data/question-library.json`: 1-X-2 multiple choice,
// tagged by topic / age / difficulty. No runtime AI. Seeding is idempotent and
// safe to run on every boot (the empty-check guards it). The dedupe + skip rules
// reproduce data-model §4 / LibrarySeeder.cs exactly.

const fs = require('fs');
const path = require('path');
const { QuestionTemplate } = require('../models');
const { QuestionKind } = require('../constants/enums');

// The bundled seed file (copied verbatim from the .NET embedded resource
// `Rundan.Server.Data.question-library.json`).
const JSON_PATH = path.join(__dirname, '..', 'data', 'question-library.json');

// Guard rails for a missing/oversized file. The bundled file is ~450 KB / ~1052
// rows; refuse anything implausibly large so a bad swap can't OOM the seeder.
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB hard ceiling
const INSERT_CHUNK = 500; // insertMany batch size (Mongo-friendly; not load-bearing)

/**
 * Normalise question text for dedupe: drop ALL whitespace and punctuation, then
 * lowercase. Mirrors LibrarySeeder.Normalize (C# `char.IsWhiteSpace` +
 * `char.IsPunctuation`). So "What's this?" and "Whats this" collapse to the same
 * key. Used ONLY for the first-wins dedupe — never stored.
 *
 * `\p{P}` = Unicode punctuation, `\s` = Unicode whitespace (with the `u` flag).
 * Note: .NET `char.IsPunctuation` excludes symbols (math/currency), and so does
 * `\p{P}`; we deliberately do not add `\p{S}` to stay faithful.
 */
function normalize(text) {
  return String(text)
    .replace(/[\s\p{P}]/gu, '')
    .toLowerCase();
}

// Read + parse the bundled JSON array. Returns [] (and logs) on any problem so a
// missing/corrupt/oversized file degrades to a no-op rather than crashing boot.
function loadFromJson() {
  let stat;
  try {
    stat = fs.statSync(JSON_PATH);
  } catch (e) {
    console.warn(`[librarySeeder] question library JSON not found at ${JSON_PATH}; no library questions seeded.`);
    return [];
  }

  if (stat.size > MAX_BYTES) {
    console.warn(`[librarySeeder] question library JSON is ${stat.size} bytes (> ${MAX_BYTES}); refusing to load.`);
    return [];
  }

  try {
    const raw = fs.readFileSync(JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn('[librarySeeder] question library JSON root is not an array; no library questions seeded.');
      return [];
    }
    return parsed;
  } catch (e) {
    console.error('[librarySeeder] failed to read/parse the question library JSON:', e.message);
    return [];
  }
}

// Build a QuestionTemplate doc from one raw entry. Mirrors LibrarySeeder.Add:
// Kind = MultipleChoice, Points = 1; options get sequential Order 0,1,2 with
// IsCorrect from `correct`; tags trimmed + lowercased, blanks dropped.
// Property reads are case-insensitive-tolerant where the .NET parser was
// (System.Text.Json with PropertyNameCaseInsensitive = true): the bundled file
// is all-lowercase, but we accept Text/Options/Correct/Tags too, defensively.
function toTemplate(entry) {
  const rawOptions = entry.options ?? entry.Options ?? [];
  const rawTags = entry.tags ?? entry.Tags ?? [];
  const text = (entry.text ?? entry.Text ?? '').trim();

  const options = rawOptions.map((o, i) => ({
    order: i,
    text: (o.text ?? o.Text ?? '').trim(),
    isCorrect: Boolean(o.correct ?? o.Correct ?? false),
  }));

  const tags = rawTags
    .filter((t) => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim().toLowerCase());

  return {
    text,
    kind: QuestionKind.MultipleChoice,
    points: 1,
    options,
    tags,
  };
}

// Count of correct options in a raw entry (case-insensitive on the property).
function correctCount(entry) {
  const rawOptions = entry.options ?? entry.Options ?? [];
  return rawOptions.reduce((n, o) => n + (o.correct ?? o.Correct ? 1 : 0), 0);
}

// Length of the options array in a raw entry (or -1 if absent/not an array).
function optionCount(entry) {
  const rawOptions = entry.options ?? entry.Options;
  return Array.isArray(rawOptions) ? rawOptions.length : -1;
}

/**
 * Seed the question library if (and only if) it's empty.
 *
 * Idempotent: if ANY QuestionTemplate already exists, this is a no-op. Otherwise
 * it loads the bundled JSON, applies the exact skip/dedupe rules from
 * data-model §4, and bulk-inserts the survivors.
 *
 * Rules (reproduced exactly from LibrarySeeder.cs):
 *  - Skip an entry whose text is blank, OR whose options.length != 3, OR whose
 *    correct-option count != 1 (the "1-X-2" tradition: exactly 3 options, one
 *    correct).
 *  - Dedupe by normalised text (lowercase, strip whitespace + punctuation) —
 *    FIRST occurrence wins; later duplicates are skipped.
 *  - Per surviving template: Kind = MultipleChoice, Points = 1; options Order
 *    0,1,2 + IsCorrect from `correct`; tags trimmed + lowercased, blanks dropped.
 *
 * @returns {Promise<boolean>} true if it seeded at least one template; false if
 *   it was already populated or the JSON was empty/missing.
 */
async function seedIfEmpty() {
  // Idempotent guard — seed only once.
  if (await QuestionTemplate.exists({})) {
    return false;
  }

  const entries = loadFromJson();
  if (entries.length === 0) {
    console.warn('[librarySeeder] question library JSON was empty or missing; no library questions seeded.');
    return false;
  }

  const seen = new Set(); // normalised-text dedupe set (first wins)
  const templates = [];

  for (const entry of entries) {
    const text = (entry.text ?? entry.Text ?? '').trim();

    // Exactly 3 options (the 1-X-2 tradition); skip blanks / wrong shape.
    if (text.length === 0 || optionCount(entry) !== 3) {
      continue;
    }

    // Exactly one correct option; skip anything malformed.
    if (correctCount(entry) !== 1) {
      continue;
    }

    // Dedupe by normalised text so repeated facts across batches collapse.
    const key = normalize(text);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    templates.push(toTemplate(entry));
  }

  if (templates.length === 0) {
    console.warn('[librarySeeder] no valid library questions after filtering; nothing seeded.');
    return false;
  }

  // Bulk insert in chunks. `ordered: false` lets the rest proceed if a single
  // doc somehow trips validation (it shouldn't — we've already filtered).
  for (let i = 0; i < templates.length; i += INSERT_CHUNK) {
    const chunk = templates.slice(i, i + INSERT_CHUNK);
    // eslint-disable-next-line no-await-in-loop
    await QuestionTemplate.insertMany(chunk, { ordered: false });
  }

  console.log(`[librarySeeder] Seeded ${templates.length} library questions.`);
  return true;
}

module.exports = {
  seedIfEmpty,
  // Exposed for tests / reuse.
  normalize,
};
