const mongoose = require('mongoose');
const {
  ActivityType, ActivityStatus, ScoringMode, Measurement,
  MatchFormat, TournamentScoring, ScoreEntryMode, ImpostureScoring, values,
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

// A source Spotify playlist remembered on a MusicQuiz so the host can import more
// tracks later — round-robin across all saved playlists. Lives on the activity,
// so it survives a results reset and track deletions (which only touch Questions).
// The metadata is a best-effort snapshot taken from Spotify when the playlist is
// added (title/owner/cover/track count), purely for display.
const musicPlaylistSchema = new mongoose.Schema({
  playlistId: { type: String, required: true, maxlength: 64 },
  url: { type: String, maxlength: 500, default: null },
  title: { type: String, maxlength: 300, default: null },
  ownerName: { type: String, maxlength: 200, default: null },
  imageUrl: { type: String, maxlength: 500, default: null },
  trackCount: { type: Number, default: null },
  description: { type: String, maxlength: 1000, default: null },
  addedUtc: { type: Date, default: Date.now },
});

// One secret word (with optional category hint) for an Imposture game.
const impostureWordSchema = new mongoose.Schema({
  word: { type: String, required: true, maxlength: 80 },
  category: { type: String, maxlength: 80, default: null },
});

// The single ACTIVE Imposture round, embedded on the activity (host-paced, one at
// a time). impostorIds is SERVER-ONLY — never sent to non-impostors. phase walks
// 0 clues → 1 voting → 2 revealed. Replaced when the host starts the next round.
const impostureRoundSchema = new mongoose.Schema({
  order: { type: Number, default: 0 },
  word: { type: String, default: null },
  category: { type: String, default: null },
  impostorIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  phase: { type: Number, default: 0 },
  startedUtc: { type: Date, default: Date.now },
  scored: { type: Boolean, default: false },
  // Word-guess (StandardPlusGuess scheme): a caught impostor's one guess.
  guess: { type: String, default: null },
  guessCorrect: { type: Boolean, default: false },
  guessByParticipantId: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { _id: false });

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
  hitsterMode: { type: Boolean, default: false },
  hitsterCardsToWin: { type: Number, default: 10 },
  // Loose ref (no cascade) — a deleted connection just falls back to free entry.
  spotifyConnectionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  hideQuestionsFromHost: { type: Boolean, default: false },

  // Imposture (find-the-impostor word game)
  impostorCount: { type: Number, default: 1 },
  revealCategoryToImpostor: { type: Boolean, default: true },
  impostureScoring: { type: Number, enum: values(ImpostureScoring), default: ImpostureScoring.Standard },

  // Library reuse. inLibrary = saved as a reusable template in its owner's library
  // (a standalone activity, eventId null, owned by `owner`). isPublic = that library
  // template is ALSO shared publicly with every logged-in user. isPublic is only
  // meaningful alongside inLibrary; the public-library list is inLibrary && isPublic.
  inLibrary: { type: Boolean, default: false },
  isPublic: { type: Boolean, default: false },
  // Set on an event copy to the library template it was deep-copied from, so a
  // template can report which events use copies of it (GET /activities/:id/used-in).
  copiedFromId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

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
  // Source playlists for a MusicQuiz (import more later; round-robin across them).
  musicPlaylists: { type: [musicPlaylistSchema], default: [] },
  // Imposture: the host-authored secret-word list + the current live round.
  impostureWords: { type: [impostureWordSchema], default: [] },
  impostureRound: { type: impostureRoundSchema, default: null },
});

activitySchema.index({ eventId: 1, order: 1 });

module.exports = mongoose.model('Activity', activitySchema);
