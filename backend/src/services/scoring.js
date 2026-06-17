// Pure scoring helpers — the MERN port of rundan's `ScoringHelper.cs` plus the
// answer-evaluation logic from `GameService.cs` (Quiz / Tipspromenad / MusicQuiz).
//
// Everything here is SIDE-EFFECT FREE: no DB, no clock except the optional `now`
// passed into scoreAnswer's speed scoring (so it stays testable / fakeable). The
// scoreboard and the event standings both rank through `rankKey` /
// `pushesUnscoredLast` so they can never diverge — this is the single source of
// ranking truth (see spec §2).
const { ActivityType, QuestionKind, ScoringMode } = require('../constants/enums');
const { RuleViolation } = require('../middleware/error');

// MusicQuiz answer window in seconds: drives the player/host countdown and the
// auto-finish cutoff, and (in Kahoot speed mode) caps the time penalty charged
// when a track was answered without a start stamp. Mirrors GameService.SpeedWindowSeconds.
const SPEED_WINDOW_SECONDS = 30;
// Hitster year scoring tolerance: within this many years earns half credit.
const YEAR_TOLERANCE = 2;

// ── Ranking primitives (ScoringHelper.cs — port verbatim) ─────────────────────

// Sort key for a score under a scoring mode (LOWER key = better rank):
//   HigherWins      -> -score   (so a bigger score sorts first)
//   LowerWins       ->  score
//   ClosestToTarget -> |score - target|
// Kept as a plain function so both scoreboard and placement call the identical math.
function rankKey(mode, score, target) {
  switch (mode) {
    case ScoringMode.LowerWins:
      return score;
    case ScoringMode.ClosestToTarget:
      return Math.abs(score - target);
    default: // HigherWins (and any unknown mode)
      return -score;
  }
}

// In lowest/closest games a team that recorded NOTHING must not outrank real
// results with its seeded 0 — these modes push the unscored to the bottom. In
// HigherWins a 0 is genuinely last, so unscored sort naturally and this is false.
function pushesUnscoredLast(mode) {
  return mode === ScoringMode.LowerWins || mode === ScoringMode.ClosestToTarget;
}

// ── Standard competition ranking ("1, 1, 3") ─────────────────────────────────
// Walk an already-ordered list of rows, assigning 1-based `rank` where tied
// rows (same key AND same unscored flag) share the lower number and the next
// distinct key jumps to its positional rank. `keyOf(row)` returns the rank key;
// `unscoredOf(row)` returns the unscored flag (defaults to always-false).
// Mutates each row's `rank` and returns the same list. Float keys compare with
// === / !== exactly as C# double equality (no epsilon) so ties group identically.
function assignCompetitionRanks(orderedRows, keyOf, unscoredOf = () => false) {
  let rank = 0;
  let previousKey = null;
  let previousUnscored = null;
  let seen = 0;
  for (const row of orderedRows) {
    seen += 1;
    const key = keyOf(row);
    const unscored = unscoredOf(row);
    if (previousKey === null || key !== previousKey || unscored !== previousUnscored) {
      rank = seen;
      previousKey = key;
      previousUnscored = unscored;
    }
    row.rank = rank;
  }
  return orderedRows;
}

// Case-insensitive ordinal-ish display-name tiebreaker (mirrors C#
// StringComparer.OrdinalIgnoreCase used by the scoreboard / standings sorts).
function compareNameCaseInsensitive(a, b) {
  const x = (a || '').toLowerCase();
  const y = (b || '').toLowerCase();
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

/**
 * Rank score-game rows for the live scoreboard (spec §4 steps 8–9).
 *
 * @param {Array<{participantId:*, displayName?:string, totalPoints:number, entries:number}>} rows
 * @param {{scoringMode:number, targetValue?:number}} opts
 * @returns {Array} the SAME rows, sorted in finishing order with a 1-based
 *          `rank` set on each (ties share the lower rank). Sort order:
 *          Unscored(false<true) -> rankKey(asc) -> displayName(case-insensitive).
 */
function rankRows(rows, { scoringMode, targetValue } = {}) {
  const mode = scoringMode;
  const target = targetValue != null ? targetValue : 0;
  const pushLast = pushesUnscoredLast(mode);

  const keyOf = (e) => rankKey(mode, e.totalPoints, target);
  const unscoredOf = (e) => pushLast && e.entries === 0;

  rows.sort((a, b) => {
    // 1) Unscored last (false sorts before true).
    const ua = unscoredOf(a);
    const ub = unscoredOf(b);
    if (ua !== ub) return ua ? 1 : -1;
    // 2) Rank key ascending.
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    // 3) Display name, case-insensitive.
    return compareNameCaseInsensitive(a.displayName, b.displayName);
  });

  return assignCompetitionRanks(rows, keyOf, unscoredOf);
}

// ── MusicQuiz / quiz answer normalization + scoring (GameService.cs) ───────────

// Lenient match for MUSIC answers: an accepted value must be non-blank and the
// guess must normalize to the same string. Used for song title + artist.
function matches(guess, accepted) {
  if (!accepted || accepted.trim().length === 0) return false;
  return normalize(guess) === normalize(accepted);
}

// Lenient normalization for music matching (verbatim port of Normalize):
//   1. blank -> ""
//   2. trim + lowercase, NFD-decompose, drop combining marks (é→e, ö→o, å→a)
//   3. keep only letters/digits + whitespace (drop punctuation)
//   4. collapse whitespace runs to single spaces; strip a single leading "the ".
function normalize(s) {
  if (s === null || s === undefined) return '';
  const trimmed = String(s).trim();
  if (trimmed.length === 0) return '';

  // Decompose accents into separate combining marks, then strip those marks.
  const decomposed = trimmed.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  // Keep letters/numbers; turn any other run into a space (punctuation dropped).
  const kept = decomposed.replace(/[^\p{L}\p{N}]+/gu, ' ');
  // Collapse repeated spaces and trim the edges.
  const cleaned = kept.replace(/\s+/g, ' ').trim();
  // Strip a single leading "the " (only at the very start), as the C# does.
  return cleaned.startsWith('the ') ? cleaned.slice(4) : cleaned;
}

// Levenshtein edit distance for fuzzy string matching.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Fuzzy match: exact normalized match OR Levenshtein distance <= 30% of length.
function fuzzyMatches(guess, accepted) {
  if (!accepted || accepted.trim().length === 0) return false;
  const a = normalize(guess);
  const b = normalize(accepted);
  if (a === b) return true;
  if (!a || !b) return false;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen > 0 && dist / maxLen <= 0.3;
}

// Hitster year scoring: exact year = full points, within two years = half
// (floored, min 1), else 0. The `points <= 0` guard stops the half-credit floor
// of 1 from out-scoring an exact hit on a 0-point track. Integer division to
// mirror C# `points / 2`.
function scoreYear(guess, correct, points) {
  if (guess === null || guess === undefined
    || correct === null || correct === undefined
    || !Number.isFinite(points) || points <= 0) {
    return 0;
  }
  const delta = Math.abs(guess - correct);
  if (delta === 0) return points;
  if (delta <= YEAR_TOLERANCE) return Math.max(1, Math.floor(points / 2));
  return 0;
}

// Non-music evaluation (Quiz / Tipspromenad). Returns the tuple the C# returns.
// Throws RuleViolation for the same invalid-submission cases.
function evaluateNonMusic(question, submission) {
  const kind = question.kind;
  if (kind === QuestionKind.MultipleChoice || kind === QuestionKind.TrueFalse) {
    const options = question.options || [];
    const selId = submission.selectedOptionId;
    const option = options.find((o) => String(o._id) === String(selId));
    if (!option) {
      throw new RuleViolation('Choose one of the options.');
    }
    return { isCorrect: !!option.isCorrect, selectedOptionId: option._id, freeText: null };
  }

  if (kind === QuestionKind.FreeText) {
    const given = (submission.freeText || '').trim();
    if (given.length === 0) {
      throw new RuleViolation('Type an answer first.');
    }
    // Quiz free-text uses EXACT case-insensitive equality (NOT the lenient
    // music Normalize). Accepted answer must be non-blank.
    const accepted = question.acceptedFreeTextAnswer;
    const correct = !!accepted && accepted.trim().length > 0
      && given.toLowerCase() === accepted.trim().toLowerCase();
    return { isCorrect: correct, selectedOptionId: null, freeText: given };
  }

  throw new RuleViolation('Unsupported question type.');
}

/**
 * Score a single answer submission against a question. Reproduces the scoring
 * branch of GameService.SubmitAnswerAsync for BOTH question games (Quiz /
 * Tipspromenad — MC / TrueFalse / FreeText) and MusicQuiz (song + artist match,
 * optional Hitster year closeness, optional Kahoot-style speed scoring).
 *
 * It does NOT persist anything and does NOT enforce activity status / duplicate
 * answers — that stays in the game-write service. It only computes correctness
 * and points so the route/service layer can store the resulting Answer.
 *
 * @param {object} question  Mongoose Question (lean or doc) incl. `options`.
 * @param {object} submission { selectedOptionId?, freeText? (song in music),
 *                              artistText?, year? }
 * @param {object} [ctx]     { activity?, now?: () => Date }. `activity` is needed
 *                           for MusicQuiz (type + speedScoring); `now` lets tests
 *                           fake the speed-scoring clock (defaults to real time).
 * @returns {{
 *   isCorrect:boolean, awardedPoints:number,
 *   selectedOptionId:(*|null), freeText:(string|null), artistText:(string|null),
 *   guessedYear:(number|null),
 *   songCorrect:boolean, artistCorrect:boolean,
 *   correctSong:(string|null), correctArtist:(string|null),
 *   correctYear:(number|null), yearPoints:number
 * }}
 */
function scoreAnswer(question, submission, ctx = {}) {
  const activity = ctx.activity || null;
  const now = ctx.now || (() => new Date());
  const points = question.points != null ? question.points : 0;
  const isMusic = !!activity && activity.type === ActivityType.MusicQuiz;

  if (isMusic) {
    // Song / artist / (Hitster) year. In the classic (non-speed) mode song and
    // artist each earn the full track points and the year is scored separately;
    // in Kahoot speed mode (below) they instead share a single 100-point award.
    const song = (submission.freeText || '').trim();
    const artist = (submission.artistText || '').trim();
    const asksYear = question.releaseYear !== null && question.releaseYear !== undefined;
    const yearGiven = submission.year !== null && submission.year !== undefined;
    if (song.length === 0 && artist.length === 0 && !(asksYear && yearGiven)) {
      throw new RuleViolation('Type the song, the artist or the year first.');
    }

    const songOk = matches(song, question.acceptedFreeTextAnswer);
    const artistOk = matches(artist, question.acceptedArtist);
    const guessedYear = asksYear ? (yearGiven ? submission.year : null) : null;
    const yearPoints = scoreYear(guessedYear, question.releaseYear, points);

    const isCorrect = songOk && artistOk;

    let awarded;
    if (activity.speedScoring) {
      // Kahoot-style scoring: a fully correct answer is worth 100 points minus
      // the seconds it took to answer (the host starts each track, which stamps
      // playStartedUtc). The 100 is split evenly across the components this track
      // grades, so a partial answer earns a proportional share:
      //   • tap-the-artist (musicChoices): artist is the only component → 100
      //   • free text: song + artist (+ release year when the track asks for it)
      // The release year folds into that same 100 (exact = full share, within
      // YEAR_TOLERANCE = half share) rather than adding points on top.
      let elapsed = null;
      if (question.playStartedUtc) {
        elapsed = Math.floor((now().getTime() - new Date(question.playStartedUtc).getTime()) / 1000);
      }
      // No start stamp means the answer can't be timed — charge the full window
      // rather than handing out an un-penalised 100.
      const timePenalty = Math.max(0, elapsed != null ? elapsed : SPEED_WINDOW_SECONDS);

      const kahoot = !!activity.musicChoices;
      const gradeSong = !kahoot;        // the song title is hidden in tap-the-artist mode
      const gradeArtist = true;         // the artist is always gradeable
      const gradeYear = !kahoot && asksYear;
      const componentCount = (gradeSong ? 1 : 0) + (gradeArtist ? 1 : 0) + (gradeYear ? 1 : 0);
      const share = componentCount > 0 ? 100 / componentCount : 0;

      let base = 0;
      if (gradeSong && songOk) base += share;
      if (gradeArtist && artistOk) base += share;
      if (gradeYear && guessedYear !== null) {
        const delta = Math.abs(guessedYear - question.releaseYear);
        if (delta === 0) base += share;
        else if (delta <= YEAR_TOLERANCE) base += share / 2;
      }

      awarded = base > 0 ? Math.max(0, Math.round(base) - timePenalty) : 0;
    } else {
      awarded = (songOk ? points : 0) + (artistOk ? points : 0) + yearPoints;
    }

    return {
      isCorrect,
      awardedPoints: awarded,
      selectedOptionId: null,
      freeText: song,
      artistText: artist,
      guessedYear,
      songCorrect: songOk,
      artistCorrect: artistOk,
      correctSong: question.acceptedFreeTextAnswer ?? null,
      correctArtist: question.acceptedArtist ?? null,
      correctYear: question.releaseYear ?? null,
      yearPoints,
    };
  }

  // Non-music quiz path.
  const result = evaluateNonMusic(question, submission);
  const awarded = result.isCorrect ? points : 0;
  return {
    isCorrect: result.isCorrect,
    awardedPoints: awarded,
    selectedOptionId: result.selectedOptionId,
    freeText: result.freeText,
    artistText: null,
    guessedYear: null,
    // Music-only reveal fields are inert for non-music questions.
    songCorrect: false,
    artistCorrect: false,
    correctSong: null,
    correctArtist: null,
    correctYear: null,
    yearPoints: 0,
  };
}

module.exports = {
  SPEED_WINDOW_SECONDS,
  YEAR_TOLERANCE,
  rankKey,
  pushesUnscoredLast,
  assignCompetitionRanks,
  compareNameCaseInsensitive,
  rankRows,
  matches,
  fuzzyMatches,
  levenshtein,
  normalize,
  scoreYear,
  evaluateNonMusic,
  scoreAnswer,
};
