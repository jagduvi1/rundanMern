const mongoose = require('mongoose');
const { EventScoring, TeamShuffle, SlapMode, values } = require('../constants/enums');

// A day/event grouping several activities; players join once and points sum
// into combined standings. Root collection; activities & members are separate
// collections that reference eventId (large, independently mutated).
const eventSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, maxlength: 4000, default: null },
  imageUrl: { type: String, maxlength: 500, default: null },
  teamSize: { type: Number, default: 2 },
  scoring: { type: Number, enum: values(EventScoring), default: EventScoring.Cumulative },
  teamShuffle: { type: Number, enum: values(TeamShuffle), default: TeamShuffle.EveryActivity },
  // Partner-mixer seed when teamShuffle = FixedForEvent (0 until host shuffles).
  fixedTeamSeed: { type: Number, default: 0 },
  slapMode: { type: Number, enum: values(SlapMode), default: SlapMode.Off },
  joinCode: { type: String, required: true, trim: true, maxlength: 16, unique: true },
  createdUtc: { type: Date, default: Date.now },
  // Local wall-clock availability window (NOT UTC — do not normalise). Stored as
  // a string "YYYY-MM-DDTHH:mm" to preserve the host's intended local time.
  startsAt: { type: String, default: null },
  endsAt: { type: String, default: null },

  // Hybrid-auth ownership (replaces rundan's shared admin code for per-event
  // management). owner = the account that created the event; admins = accounts
  // promoted to co-host. A global `admin`-role account can manage any event.
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null, index: true },
  admins: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Account' }], default: [] },

  // Soft archive — hides from the main listing but keeps data intact.
  isArchived: { type: Boolean, default: false },
});

module.exports = mongoose.model('Event', eventSchema);
