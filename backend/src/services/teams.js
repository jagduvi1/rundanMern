// Partner mixer + team generation — the MERN port of rundan's `TeamService.cs`
// and the pure `PartnerMixer`. Generates the per-activity team Participants from
// the event roster. By default teams reshuffle every activity (fresh teammates);
// an event can fix its teams for the whole event (TeamShuffle.FixedForEvent).
//
// The mixer is PURE and DETERMINISTIC (no RNG): the same ordered roster + seed
// always yields the same teams, so runtime generation and the demo seeder agree.
// Always order the roster by Name before mixing (callers do).
const crypto = require('crypto');
const {
  Event, EventMember, Participant, Answer, ScoreEntry,
} = require('../models');
const { TeamShuffle } = require('../constants/enums');
const { idStr } = require('./serializers');

// Single injectable clock for the `joinedUtc` stamp.
const now = () => new Date();

// ── PartnerMixer (PURE — port exactly) ────────────────────────────────────────

// Right-rotate `src` by `k` with positive modulo. Returns a new array.
function rotate(src, k) {
  const n = src.length;
  if (n === 0) return src.slice();
  const kk = ((k % n) + n) % n;
  return [...src.slice(n - kk), ...src.slice(0, n - kk)];
}

// Consecutive slices of length `size` (last may be shorter).
function chunk(src, size) {
  const result = [];
  for (let i = 0; i < src.length; i += size) {
    result.push(src.slice(i, i + size));
  }
  return result;
}

// Round-robin circle method: distinct pairings per seed; an odd roster leaves
// one solo team (the player paired with the "bye").
function pairs(members, seed) {
  const players = members.slice(); // copy of the User objects
  if (players.length % 2 === 1) {
    players.push(null); // bye
  }

  const n = players.length;
  const rounds = n - 1;
  const r = rounds === 0 ? 0 : (((seed - 1) % rounds) + rounds) % rounds;

  // Fix the first player, rotate the rest.
  const arranged = [players[0], ...rotate(players.slice(1), r)];

  const teams = [];
  for (let i = 0; i < Math.floor(n / 2); i += 1) {
    const team = [];
    const a = arranged[i];
    const b = arranged[n - 1 - i];
    if (a) team.push(a);
    if (b) team.push(b);
    if (team.length > 0) teams.push(team); // a bye-pairing becomes a solo team
  }
  return teams;
}

/**
 * Make teams from an ordered roster (PURE). `seed` selects which line-up to
 * produce: per-activity mode passes the activity order; fixed mode the event seed.
 *
 * @param {Array} members   roster users (ordered by name), each `{ _id, name }`.
 * @param {number} teamSize desired team size.
 * @param {number} seed     line-up selector.
 * @returns {Array<Array>} array of teams, each an array of the member objects.
 */
function makeTeams(members, teamSize, seed) {
  if (teamSize <= 1) {
    return members.map((u) => [u]); // each member is their own singleton team
  }
  if (teamSize === 2) {
    return pairs(members, seed);
  }
  // General case (>=3): rotate the roster by the seed ITSELF (not a multiple of
  // teamSize, which would shift whole chunks and reproduce identical teams),
  // then chunk into consecutive groups.
  const round = Math.max(0, seed - 1);
  const rotated = rotate(members.slice(), round % members.length);
  return chunk(rotated, teamSize);
}

// The mixer seed for an activity: fixed per-event, or the activity's order.
function seedFor(ev, activity) {
  return ev.teamShuffle === TeamShuffle.FixedForEvent ? ev.fixedTeamSeed : activity.order;
}

// Load the event roster ordered by name (mirrors the C# `OrderBy(u => u.Name)`).
async function loadRoster(eventId) {
  const members = await EventMember.find({ eventId })
    .select('userId')
    .populate('userId', 'name')
    .lean();
  return members
    .filter((m) => m.userId) // defensive against a deleted user
    .map((m) => m.userId)
    .sort((a, b) => {
      const x = (a.name || '').toLowerCase();
      const y = (b.name || '').toLowerCase();
      if (x < y) return -1;
      if (x > y) return 1;
      return 0;
    });
}

// ── TeamService operations ────────────────────────────────────────────────────

/**
 * Ensure team participants exist for an event-activity (idempotent). Returns the
 * existing teams if already generated, otherwise generates and saves them.
 * Returns `[]` for standalone activities (no eventId) or events with no roster.
 *
 * @param {object|null} event    the event doc (lean or Mongoose). If null/omitted
 *                               it is loaded from `activity.eventId`.
 * @param {object} activity      the activity doc (needs `_id`, `eventId`, `order`).
 * @returns {Promise<Array>} the team Participant docs (Mongoose documents), each
 *   with its `members:[{userId}]`. Routes can serialize via participantDto / build
 *   TeamDto-style shapes from them.
 */
async function ensureTeams(event, activity) {
  if (!activity.eventId) return []; // standalone activities have no auto teams

  // Already generated? Return existing teams (idempotent).
  const existing = await Participant.find({ activityId: activity._id, isTeam: true });
  if (existing.length > 0) return existing;

  const ev = event || await Event.findById(activity.eventId).lean();
  if (!ev) return [];

  const roster = await loadRoster(activity.eventId);
  if (roster.length === 0) return [];

  const groups = makeTeams(roster, Math.max(1, ev.teamSize), seedFor(ev, activity));

  // Create each team. A concurrent generator (two devices claiming the instant the
  // activity opens) can race here — both saw no existing teams — so swallow the
  // unique-index collision (E11000) on { activityId, displayName } and re-read at
  // the end. Every racer then returns the full, consistent team set instead of a
  // 500 / partial list (which would drop a roster member onto the free-name path).
  for (const group of groups) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await Participant.create({
        activityId: activity._id,
        displayName: group.map((u) => u.name).join(' & '),
        isTeam: true,
        token: crypto.randomUUID(),
        joinedUtc: now(),
        members: group.map((u) => ({ userId: u._id })),
      });
    } catch (e) {
      if (!(e && e.code === 11000)) throw e; // raced — the other request created this team
    }
  }
  return Participant.find({ activityId: activity._id, isTeam: true });
}

/**
 * Compute the teams an event's roster would form right now WITHOUT persisting —
 * used to show the host the line-up / preview a reshuffle.
 *
 * @param {object} event  the event doc (needs `_id`, `teamSize`, `teamShuffle`,
 *                        `fixedTeamSeed`).
 * @returns {Promise<Array>} TeamDto-shaped rows:
 *   [{ name, members: [{ id, name }] }]
 *   (activityId/participantId are unknown for a preview, so omitted.)
 */
async function previewTeams(event) {
  const roster = await loadRoster(event._id);
  if (roster.length === 0) return [];

  // Per-activity mode previews always use seed 1; fixed mode uses the event seed.
  const seed = event.teamShuffle === TeamShuffle.FixedForEvent ? event.fixedTeamSeed : 1;
  return makeTeams(roster, Math.max(1, event.teamSize), seed).map((group) => ({
    name: group.map((u) => u.name).join(' & '),
    members: group.map((u) => ({ id: idStr(u), name: u.name })),
  }));
}

/**
 * Drop the generated team participants for an event's activities that HAVEN'T
 * been played yet (no answers, no score entries), so they regenerate with the
 * current seed. Teams of in-play activities are left untouched. Used when fixed
 * teams are reshuffled.
 *
 * @param {*} eventId
 * @returns {Promise<number>} how many stale team participants were removed.
 */
async function resetUnplayedTeams(eventId) {
  // Team participants of the event's activities. We join Participant -> Activity
  // by eventId via the activity id set.
  const { Activity } = require('../models'); // eslint-disable-line global-require
  const activityIds = await Activity.find({ eventId }).distinct('_id');
  if (activityIds.length === 0) return 0;

  const teamParts = await Participant.find({
    activityId: { $in: activityIds },
    isTeam: true,
  }).select('_id').lean();
  if (teamParts.length === 0) return 0;

  // "Played" = has any Answer OR any ScoreEntry. Find which participants are
  // in-play and keep those; the rest are stale and get removed.
  const partIds = teamParts.map((p) => p._id);
  const [answered, scored] = await Promise.all([
    Answer.find({ participantId: { $in: partIds } }).distinct('participantId'),
    ScoreEntry.find({ participantId: { $in: partIds } }).distinct('participantId'),
  ]);
  const inPlay = new Set([...answered, ...scored].map((id) => idStr(id)));

  const stale = partIds.filter((id) => !inPlay.has(idStr(id)));
  if (stale.length === 0) return 0;

  // Members are embedded, so deleting the participant removes them too.
  const res = await Participant.deleteMany({ _id: { $in: stale } });
  return res.deletedCount || 0;
}

module.exports = {
  // Pure mixer (exported for the demo seeder + tests).
  makeTeams,
  rotate,
  chunk,
  pairs,
  seedFor,
  // DB operations.
  ensureTeams,
  previewTeams,
  resetUnplayedTeams,
};
