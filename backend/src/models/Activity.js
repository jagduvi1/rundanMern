const mongoose = require('mongoose');
const {
  ActivityType, ActivityStatus, ScoringMode, Measurement,
  MatchFormat, TournamentScoring, ScoreEntryMode, values,
} = require('../constants/enums');

// ── Embedded subdocuments (small, ordered, always loaded with the activity) ──

// A playing surface (court/field/track/lane). Keep _id: BracketMatch.courtId
// references the court subdoc's _id across collections.
const courtSchema = new mongoose.Schema({
  order: { type: Number, default: 0 },
  name: { type: String, required: true, maxlength: 60 },
});

// One drawn city in a MapPin activity. latitude/longitude are SERVER-ONLY —
// strip them from player payloads until the round is revealed. order links to
// the team's ScoreEntry.round for that pin.
const mapCitySchema = new mongoose.Schema({
  order: { type: Number, default: 0 },
  name: { type: String, required: true, maxlength: 120 },
  latitude: { type: Number, default: 0 },
  longitude: { type: Number, default: 0 },
});

// One label in a Memory game; becomes two matching cards on the shuffled board.
const memoryCardSchema = new mongoose.Schema({
  order: { type: Number, default: 0 },
  text: { type: String, required: true, maxlength: 120 },
});

// ── Activity ────────────────────────────────────────────────────────────────
// The big polymorphic game instance; many fields are type-specific (quiz,
// tipspromenad, boule/bracket, score game, word game, map-pin, music, memory).
const activitySchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', default: null },
  order: { type: Number, default: 0 },
  type: { type: Number, enum: values(ActivityType), required: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, maxlength: 4000, default: null },
  imageUrl: { type: String, maxlength: 500, default: null },
  status: { type: Number, enum: values(ActivityStatus), default: ActivityStatus.Draft },
  joinCode: { type: String, required: true, trim: true, maxlength: 16, unique: true },

  // Scoring / ranking
  scoringMode: { type: Number, enum: values(ScoringMode), default: ScoringMode.HigherWins },
  measurement: { type: Number, enum: values(Measurement), default: Measurement.Points },
  targetValue: { type: Number, default: null },

  // Boule / bracket configuration
  matchFormat: { type: Number, enum: values(MatchFormat), default: MatchFormat.Free },
  bestOfSets: { type: Number, default: 3 },
  gamesToWinSet: { type: Number, default: 13 },
  useGroupStage: { type: Boolean, default: false },
  groupCount: { type: Number, default: 0 },
  groupMatchFormat: { type: Number, enum: values(MatchFormat), default: MatchFormat.Free },
  groupBestOfSets: { type: Number, default: 1 },
  groupGamesToWinSet: { type: Number, default: 13 },
  advanceToPlayoffA: { type: Number, default: 2 },
  advanceToPlayoffB: { type: Number, default: 0 },
  playoffAConsolation: { type: Boolean, default: true },
  playoffBConsolation: { type: Boolean, default: false },
  useManualSeeding: { type: Boolean, default: false },
  tournamentScoring: { type: Number, enum: values(TournamentScoring), default: TournamentScoring.PerWin },

  // Quiz / music
  randomizeQuestions: { type: Boolean, default: false },
  musicChoices: { type: Boolean, default: false },
  speedScoring: { type: Boolean, default: false },
  // Loose ref (no cascade) — a deleted connection just falls back to free entry.
  spotifyConnectionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  hideQuestionsFromHost: { type: Boolean, default: false },

  // Library reuse
  isPublic: { type: Boolean, default: false },

  // Standalone-activity ownership (the account that created it). Event activities
  // are governed by their event's owner/admins instead. Null for legacy/seeded
  // activities, which fall back to the dev-open management rule.
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null, index: true },

  // Score game / rounds
  courtLabel: { type: String, default: 'Court' },
  scoreEntryMode: { type: Number, enum: values(ScoreEntryMode), default: ScoreEntryMode.Team },
  roundCount: { type: Number, default: 1 },
  playersPerRound: { type: Number, default: null },

  // Geofence (Tipspromenad single-location / MapPin)
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  radiusMeters: { type: Number, default: null },
  mapCityCount: { type: Number, default: null },

  createdUtc: { type: Date, default: Date.now },
  startedUtc: { type: Date, default: null },
  finishedUtc: { type: Date, default: null },

  // Embedded config lists
  courts: { type: [courtSchema], default: [] },
  mapCities: { type: [mapCitySchema], default: [] },
  memoryCards: { type: [memoryCardSchema], default: [] },
});

activitySchema.index({ eventId: 1, order: 1 });

module.exports = mongoose.model('Activity', activitySchema);
