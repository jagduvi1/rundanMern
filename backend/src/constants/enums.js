// Wire-compatible enums. rundan (.NET + System.Text.Json) serialised every enum
// as its underlying INTEGER, and the SQLite columns store those integers. The
// MERN port preserves the EXACT same integer codes so stored data and any old
// clients stay numerically identical. Do NOT reorder or renumber.
//
// This file is duplicated (identical values) in frontend/src/config/enums.js as
// an ES module — keep the two in sync.

const ActivityType = Object.freeze({
  Quiz: 1,
  Tipspromenad: 2,
  Boule: 3,
  ScoreGame: 4,
  WordGame: 5,
  MapPin: 6,
  MusicQuiz: 7,
  Memory: 8,
  Imposture: 9,
});

// Imposture (the "find the impostor" word game) scoring scheme — host-selectable.
//   CatchersOnly      : only players who vote the impostor score.
//   Standard          : catchers score AND the impostor scores for surviving.
//   StandardPlusGuess : Standard, plus a caught impostor may guess the word for a bonus.
const ImpostureScoring = Object.freeze({
  CatchersOnly: 0,
  Standard: 1,
  StandardPlusGuess: 2,
});

const ActivityStatus = Object.freeze({
  Draft: 0,
  Open: 1,
  Live: 2,
  Finished: 3,
});

const QuestionKind = Object.freeze({
  MultipleChoice: 0,
  TrueFalse: 1,
  FreeText: 2,
});

const EventScoring = Object.freeze({
  Cumulative: 0,
  Placement: 1,
});

const MatchFormat = Object.freeze({
  Free: 0,
  Sets: 1,
});

const TournamentScoring = Object.freeze({
  PerWin: 0,
  Placement: 1,
});

const TeamShuffle = Object.freeze({
  EveryActivity: 0,
  FixedForEvent: 1,
});

const ScoreEntryMode = Object.freeze({
  Team: 0,
  PerPlayer: 1,
});

const SlapMode = Object.freeze({
  Off: 0,
  Vanish: 1,
  SendToPlayer: 2,
  Random: 3,
  SlappedSends: 4,
});

// Computed/DTO-only enum (never persisted as a column).
const SlapState = Object.freeze({
  None: 0,
  Pending: 1,
  Taken: 2,
  Skipped: 3,
  AwaitingRecipient: 4,
});

const BracketSide = Object.freeze({
  Winners: 0,
  Losers: 1,
});

const Measurement = Object.freeze({
  Points: 0,
  TimeSeconds: 1,
  Millimetres: 2,
});

const ScoringMode = Object.freeze({
  HigherWins: 0,
  LowerWins: 1,
  ClosestToTarget: 2,
});

// Helper for Mongoose `enum:` validators — the list of valid integer codes.
const values = (e) => Object.values(e);

module.exports = {
  ActivityType,
  ImpostureScoring,
  ActivityStatus,
  QuestionKind,
  EventScoring,
  MatchFormat,
  TournamentScoring,
  TeamShuffle,
  ScoreEntryMode,
  SlapMode,
  SlapState,
  BracketSide,
  Measurement,
  ScoringMode,
  values,
};
