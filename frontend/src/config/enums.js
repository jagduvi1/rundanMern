// Wire-compatible enums — the ES-module mirror of backend/src/constants/enums.js.
// EXACT same integer codes (rundan serialized enums as ints). Keep in sync.

export const ActivityType = Object.freeze({
  Quiz: 1, Tipspromenad: 2, Boule: 3, ScoreGame: 4,
  WordGame: 5, MapPin: 6, MusicQuiz: 7, Memory: 8,
});
export const ActivityStatus = Object.freeze({ Draft: 0, Open: 1, Live: 2, Finished: 3 });
export const QuestionKind = Object.freeze({ MultipleChoice: 0, TrueFalse: 1, FreeText: 2 });
export const EventScoring = Object.freeze({ Cumulative: 0, Placement: 1 });
export const MatchFormat = Object.freeze({ Free: 0, Sets: 1 });
export const TournamentScoring = Object.freeze({ PerWin: 0, Placement: 1 });
export const TeamShuffle = Object.freeze({ EveryActivity: 0, FixedForEvent: 1 });
export const ScoreEntryMode = Object.freeze({ Team: 0, PerPlayer: 1 });
export const SlapMode = Object.freeze({ Off: 0, Vanish: 1, SendToPlayer: 2, Random: 3, SlappedSends: 4 });
export const SlapState = Object.freeze({ None: 0, Pending: 1, Taken: 2, Skipped: 3, AwaitingRecipient: 4 });
export const BracketSide = Object.freeze({ Winners: 0, Losers: 1 });
export const Measurement = Object.freeze({ Points: 0, TimeSeconds: 1, Millimetres: 2 });
export const ScoringMode = Object.freeze({ HigherWins: 0, LowerWins: 1, ClosestToTarget: 2 });

// Display labels (Swedish — matches the original app's UI language).
export const ActivityTypeLabel = Object.freeze({
  [ActivityType.Quiz]: 'Quiz',
  [ActivityType.Tipspromenad]: 'Tipspromenad',
  [ActivityType.Boule]: 'Boule',
  [ActivityType.ScoreGame]: 'Poängspel',
  [ActivityType.WordGame]: 'Ordspel',
  [ActivityType.MapPin]: 'Kartnål',
  [ActivityType.MusicQuiz]: 'Musikquiz',
  [ActivityType.Memory]: 'Memory',
});
export const ActivityStatusLabel = Object.freeze({
  [ActivityStatus.Draft]: 'Utkast',
  [ActivityStatus.Open]: 'Öppen',
  [ActivityStatus.Live]: 'Pågår',
  [ActivityStatus.Finished]: 'Avslutad',
});

// Reverse lookup helper for any enum object.
export const nameOf = (enumObj, value) =>
  Object.keys(enumObj).find((k) => enumObj[k] === value) || String(value);
