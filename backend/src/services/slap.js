// SlapService — the "slap" ceremony twist (port of
// Rundan.Server/Services/SlapService.cs).
//
// After an activity finishes (points already counted), the winning team slaps a
// rival, halving that rival's lead over the player just below them in the current
// event standings. The lost points vanish or are handed to another player, per
// SlapMode. One slap per activity; it must be resolved (taken) or host-skipped
// before the next activity starts.
//
// Persistence: at most one Slap doc per activity (unique activityId). A skipped
// slap is still a Slap row (skipped=true) so it won't be re-offered.

const {
  Event, Activity, EventMember, User, Participant, Slap,
} = require('../models');
const { idStr } = require('./serializers');
const { SlapMode, SlapState, ActivityStatus } = require('../constants/enums');
const { RuleViolation } = require('../middleware/error');

// ── Sibling service resolution (scoreboard + event standings) ─────────────────
//
// SlapService depends on the per-activity scoreboard (rank-1 winners) and the
// combined event standings (totals + penalty floor). Those siblings are built
// separately; resolve them lazily so this module loads regardless of import order
// and we don't hard-couple to one export name.

// Returns a build fn `(activityId) -> Promise<{entries:[...]}|null>`.
function resolveScoreboardBuild() {
  // eslint-disable-next-line global-require
  const mod = require('./scoreboard');
  const fn = mod.buildScoreboard || mod.build || mod.getScoreboard || mod.scoreboardDto;
  if (typeof fn !== 'function') {
    throw new RuleViolation('Scoreboard service unavailable.', 500);
  }
  return fn;
}

// Returns a build fn `(eventId) -> Promise<{entries:[...]}|null>`.
function resolveStandingsBuild() {
  // eslint-disable-next-line global-require
  const mod = require('./standings');
  const fn = mod.buildStandings || mod.build || mod.getStandings || mod.standingsDto;
  if (typeof fn !== 'function') {
    throw new RuleViolation('Standings service unavailable.', 500);
  }
  return fn;
}

const buildScoreboard = (activityId) => resolveScoreboardBuild()(activityId);
const buildStandings = (eventId) => resolveStandingsBuild()(eventId);

// ── Deterministic hash (Knuth multiplicative, unchecked 32-bit) ───────────────
//
// The two seeded decisions (EffectiveMode for Random, slapper tie-break) hash the
// activity id. Mongo ids are ObjectIds, so derive a stable 32-bit integer
// surrogate (last 8 hex chars) and hash it exactly as the .NET `(uint)id *
// 2654435761` with 32-bit overflow. Only determinism + stability matter (no
// legacy numeric value to match).
const MASK32 = 0xffffffffn;

function intSurrogate(id) {
  const s = idStr(id);
  if (s && /^[0-9a-fA-F]{24}$/.test(s)) {
    return BigInt(Number.parseInt(s.slice(16), 16) >>> 0);
  }
  // Fallback hash over the string.
  let h = 2166136261;
  for (let i = 0; i < (s ? s.length : 0); i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return BigInt(h >>> 0);
}

// (uint)(surrogate * 2654435761) mod 2^32, as a BigInt.
function activityHash(activityId) {
  return (intSurrogate(activityId) * 2654435761n) & MASK32;
}

/**
 * Resolves SlapMode.Random to Vanish/SendToPlayer deterministically per activity
 * (stable across restarts). Non-Random modes pass through unchanged.
 * @param {number} mode A SlapMode value.
 * @param {string|ObjectId} activityId
 * @returns {number} A SlapMode value (never Random).
 */
function effectiveMode(mode, activityId) {
  if (mode !== SlapMode.Random) return mode;
  const hash = activityHash(activityId);
  return ((hash >> 13n) & 1n) === 0n ? SlapMode.Vanish : SlapMode.SendToPlayer;
}

// ── Member helpers ────────────────────────────────────────────────────────────

// All event members as SlapPersonDto[], ordered by name (case-insensitive).
async function membersOf(eventId) {
  const members = await EventMember.find({ eventId }).populate('userId', 'name');
  return members
    .map((m) => ({
      userId: idStr(m.userId && m.userId._id ? m.userId._id : m.userId),
      name: m.userId && m.userId.name ? m.userId.name : null,
    }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'accent' }));
}

// Distinct member user-id strings of an event.
async function memberIdSet(eventId) {
  const members = await EventMember.find({ eventId }).select('userId');
  return new Set(members.map((m) => idStr(m.userId)));
}

// ── Core: winner + designated slapper ─────────────────────────────────────────

// Of the winning team's members, the one with the lowest overall event score
// takes the slap. Ties broken deterministically-at-random per activity, so the
// choice is stable across refreshes. memberIds: string[]. Returns a string id.
async function designatedSlapper(eventId, activityId, memberIds) {
  const board = await buildStandings(eventId);
  const totals = new Map();
  if (board && Array.isArray(board.entries)) {
    for (const e of board.entries) totals.set(idStr(e.userId), e.totalPoints);
  }
  const score = (uid) => (totals.has(uid) ? totals.get(uid) : 0);

  const min = Math.min(...memberIds.map(score));
  const lowest = memberIds
    .filter((uid) => score(uid) <= min + 1e-9)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (lowest.length === 1) return lowest[0];

  const hash = activityHash(activityId);
  const idx = Number(hash % BigInt(lowest.length));
  return lowest[idx];
}

// The winning team(s) (rank 1) of an activity: team name, every winning member's
// roster id (none can be slapped), and the single designated slapper. Returns
// { name, memberIds: string[], slapperUserId: string } or null.
async function winnerOf(eventId, activityId) {
  const board = await buildScoreboard(activityId);
  const top = (board && Array.isArray(board.entries))
    ? board.entries.filter((e) => e.rank === 1)
    : [];
  if (top.length === 0) return null;

  // On a first-place tie, every member of every tied team counts as a winner.
  const topIds = top.map((e) => idStr(e.participantId));
  const topParts = await Participant.find({ _id: { $in: topIds } }).select('members');
  const memberIds = [...new Set(
    topParts.flatMap((p) => (p.members || []).map((m) => idStr(m.userId)))
  )];
  if (memberIds.length === 0) return null;

  const name = top.map((e) => e.displayName).join(' & ');
  const slapperUserId = await designatedSlapper(eventId, activityId, memberIds);
  return { name, memberIds, slapperUserId };
}

// Half the slapped player's lead over the next-lower player in the current
// standings (the floor for last place is 0). Returns a number.
async function penaltyFor(eventId, slappedUserId) {
  const board = await buildStandings(eventId);
  if (!board || !Array.isArray(board.entries)) return 0;
  const entries = board.entries;

  // Match by user id, not display name — two roster players can share a name.
  const target = idStr(slappedUserId);
  const idx = entries.findIndex((e) => idStr(e.userId) === target);
  if (idx < 0) return 0;

  const total = entries[idx].totalPoints;
  // "Lead over the player JUST below them" — the immediately-following entry in
  // rank order (entries are already rank-sorted). A tied next player ⇒ 0 lead ⇒
  // 0 penalty. (Previously skipped tied players to the first strictly-lower one,
  // over-penalizing on a multi-way tie at the top.)
  const following = entries[idx + 1];
  const floor = following ? following.totalPoints : 0;
  return Math.max(0, (total - floor) / 2);
}

// ── Public: views ─────────────────────────────────────────────────────────────

/**
 * The slap for one activity as the player flow sees it (order-independent):
 * pending / taken / skipped / awaiting-recipient / none.
 * @param {object} event Unused param kept for the route's call signature; the
 *   activity's own eventId is authoritative. May be null.
 * @param {string|ObjectId} activityId
 * @returns {Promise<object>} ActivitySlapDto.
 */
async function getActivitySlap(event, activityId) {
  const result = {
    eventId: null,
    activityId: idStr(activityId),
    activityTitle: null,
    state: SlapState.None,
    effectiveMode: SlapMode.Off,
    winnerName: null,
    winnerUserIds: [],
    members: [],
    slapperUserId: null,
    slapperName: null,
    slappedUserId: null,
    slappedName: null,
    recipientName: null,
    penalty: 0,
  };

  const activity = await Activity.findById(activityId);
  if (!activity || activity.eventId == null) return result; // standalone → no slaps

  const eventId = idStr(activity.eventId);
  result.eventId = eventId;
  result.activityTitle = activity.title;

  const ev = await Event.findById(eventId);
  if (!ev || ev.slapMode === SlapMode.Off || activity.status !== ActivityStatus.Finished) {
    return result; // None
  }

  result.effectiveMode = effectiveMode(ev.slapMode, activityId);

  const slap = await Slap.findOne({ activityId: activity._id });
  if (slap) {
    if (slap.skipped) {
      result.state = SlapState.Skipped;
      return result;
    }

    const ids = [slap.slapperUserId, slap.slappedUserId, slap.recipientUserId]
      .filter((x) => x != null)
      .map((x) => idStr(x));
    const users = await User.find({ _id: { $in: ids } }).select('name');
    const names = new Map(users.map((u) => [idStr(u._id), u.name]));

    result.slapperUserId = slap.slapperUserId ? idStr(slap.slapperUserId) : null;
    result.slapperName = names.get(idStr(slap.slapperUserId)) ?? null;
    result.slappedUserId = slap.slappedUserId ? idStr(slap.slappedUserId) : null;
    result.slappedName = names.get(idStr(slap.slappedUserId)) ?? null;
    result.penalty = slap.penalty;

    // SlappedSends: the slap landed but the slapped player hasn't passed it on.
    if (result.effectiveMode === SlapMode.SlappedSends && slap.recipientUserId == null) {
      result.state = SlapState.AwaitingRecipient;
      result.members = await membersOf(eventId);
      return result;
    }

    result.state = SlapState.Taken;
    result.recipientName = slap.recipientUserId
      ? (names.get(idStr(slap.recipientUserId)) ?? null)
      : null;
    return result;
  }

  // Not resolved yet → pending, but only if there's a winner to slap with.
  const winner = await winnerOf(eventId, activityId);
  if (!winner) return result; // None — no team winner (e.g. nobody played)

  result.state = SlapState.Pending;
  result.winnerName = winner.name;
  result.winnerUserIds = winner.memberIds;
  result.slapperUserId = winner.slapperUserId;
  result.members = await membersOf(eventId);
  result.slapperName = result.members.find((m) => m.userId === winner.slapperUserId)?.name ?? null;
  return result;
}

/**
 * The first finished activity whose slap hasn't been resolved yet, if any (host
 * view — "the next slap to resolve"). Scans finished activities in running order.
 * @param {object} event A loaded Event Mongoose doc (or one with _id/slapMode).
 * @returns {Promise<object|null>} PendingSlapDto, or null if nothing pending.
 */
async function computePendingSlap(event) {
  if (!event || event.slapMode === SlapMode.Off) return null;
  const eventId = idStr(event._id);

  const finished = await Activity.find({ eventId: event._id, status: ActivityStatus.Finished })
    .select('title order')
    .sort({ order: 1 });

  const resolvedRows = await Slap.find({ eventId: event._id }).select('activityId');
  const resolved = new Set(resolvedRows.map((s) => idStr(s.activityId)));

  for (const a of finished) {
    if (resolved.has(idStr(a._id))) continue;
    // eslint-disable-next-line no-await-in-loop
    const winner = await winnerOf(eventId, a._id);
    if (!winner) continue; // no players / not a team activity → nothing to slap

    // eslint-disable-next-line no-await-in-loop
    const members = await membersOf(eventId);
    return {
      activityId: idStr(a._id),
      activityTitle: a.title,
      winnerName: winner.name,
      winnerUserIds: winner.memberIds,
      slapperUserId: winner.slapperUserId,
      slapperName: members.find((m) => m.userId === winner.slapperUserId)?.name ?? null,
      effectiveMode: effectiveMode(event.slapMode, a._id),
      members,
    };
  }

  return null;
}

// ── Public: mutations ─────────────────────────────────────────────────────────

/**
 * Performs (takes) the slap on a rival. Records a Slap doc; penalty is computed
 * from the current standings. For SendToPlayer mode a recipient is required.
 * @param {object} event A loaded Event Mongoose doc.
 * @param {object} input
 * @param {string|ObjectId} input.activityId
 * @param {string|ObjectId} input.slappedUserId
 * @param {string|ObjectId} [input.recipientUserId]
 */
async function performSlap(event, { activityId, slappedUserId, recipientUserId } = {}) {
  if (!event) throw new RuleViolation('Event not found.', 404);
  if (event.slapMode === SlapMode.Off) throw new RuleViolation('Slaps are off for this event.');

  const activity = await Activity.findOne({ _id: activityId, eventId: event._id });
  if (!activity) throw new RuleViolation('Activity not found.', 404);
  if (activity.status !== ActivityStatus.Finished) {
    throw new RuleViolation("That activity hasn't finished yet.");
  }

  if (await Slap.exists({ activityId: activity._id })) {
    throw new RuleViolation('Someone already took this slap.', 409);
  }

  const eventId = idStr(event._id);
  const winner = await winnerOf(eventId, activityId);
  if (!winner) throw new RuleViolation('This activity has no winner to slap with.');

  // NOTE: the route is responsible for authenticating WHICH user is acting and
  // passing it; the .NET service verifies the caller is the designated slapper.
  // Here the slapper is the designated one (winner.slapperUserId).
  const slapperUserId = winner.slapperUserId;

  const memberIds = await memberIdSet(eventId);
  const slapped = idStr(slappedUserId);
  if (!memberIds.has(slapped)) throw new RuleViolation('Pick a player in this event.');
  if (winner.memberIds.includes(slapped)) throw new RuleViolation("You can't slap your own team.");

  const mode = effectiveMode(event.slapMode, activityId);
  let recipient = null;
  if (mode === SlapMode.SendToPlayer) {
    const rid = recipientUserId != null ? idStr(recipientUserId) : null;
    if (rid == null) throw new RuleViolation('Pick who gets the points.');
    if (rid === slapperUserId) throw new RuleViolation("You can't send the points to yourself.");
    if (rid === slapped) {
      throw new RuleViolation('Send the points to someone other than the slapped player.');
    }
    if (!memberIds.has(rid)) throw new RuleViolation('Pick a player in this event.');
    recipient = rid;
  }

  const penalty = await penaltyFor(eventId, slappedUserId);

  try {
    await Slap.create({
      eventId: event._id,
      activityId: activity._id,
      slapperUserId,
      slappedUserId: slapped,
      recipientUserId: recipient,
      penalty,
      skipped: false,
      createdUtc: new Date(),
    });
  } catch (e) {
    // Unique on activityId — two concurrent takes race; the loser gets a clear message.
    if (e && e.code === 11000) throw new RuleViolation('Someone already resolved this slap.', 409);
    throw e;
  }
}

/**
 * SlappedSends mode: the slapped player passes their lost points to a recipient
 * (never themselves, never the slapper).
 * @param {object} event A loaded Event Mongoose doc.
 * @param {object} input
 * @param {string|ObjectId} input.activityId
 * @param {string|ObjectId} input.recipientUserId
 * @param {string|ObjectId} [input.senderUserId] The acting (slapped) user; if
 *   omitted, the recorded slappedUserId is used (route should authenticate).
 */
async function sendSlapPoints(event, { activityId, recipientUserId, senderUserId } = {}) {
  if (!event) throw new RuleViolation('Event not found.', 404);

  const slap = await Slap.findOne({ eventId: event._id, activityId });
  if (!slap) throw new RuleViolation("There's no slap to pass on here.", 404);

  if (slap.skipped || effectiveMode(event.slapMode, activityId) !== SlapMode.SlappedSends) {
    throw new RuleViolation("These points aren't yours to pass on.");
  }

  // The sender must be the slapped player. If the route doesn't pass an acting
  // user, default to the recorded slapped player (the only one allowed to pass).
  const sender = senderUserId != null ? idStr(senderUserId) : idStr(slap.slappedUserId);
  if (idStr(slap.slappedUserId) !== sender) {
    throw new RuleViolation('Only the slapped player can pass on the points.', 403);
  }

  if (slap.recipientUserId != null) {
    throw new RuleViolation("You've already passed the points on.", 409);
  }

  const recipient = idStr(recipientUserId);
  if (recipient === sender) throw new RuleViolation("You can't keep the points yourself.");
  if (recipient === idStr(slap.slapperUserId)) {
    throw new RuleViolation("You can't give them to whoever slapped you.");
  }

  const memberIds = await memberIdSet(idStr(event._id));
  if (!memberIds.has(recipient)) throw new RuleViolation('Pick a player in this event.');

  slap.recipientUserId = recipient;
  await slap.save();
}

/**
 * Host skip — records a skipped Slap so the activity's slap is resolved-by-skip.
 * No-op if a Slap already exists for the activity.
 * @param {object} event A loaded Event Mongoose doc.
 * @param {object} input
 * @param {string|ObjectId} input.activityId
 */
async function skipSlap(event, { activityId } = {}) {
  if (!event) throw new RuleViolation('Event not found.', 404);
  if (await Slap.exists({ activityId })) return; // already resolved

  await Slap.create({
    eventId: event._id,
    activityId,
    slapperUserId: null,
    slappedUserId: null,
    recipientUserId: null,
    penalty: 0,
    skipped: true,
    createdUtc: new Date(),
  });
}

module.exports = {
  getActivitySlap,
  computePendingSlap,
  performSlap,
  sendSlapPoints,
  skipSlap,
  // Exposed for tests / reuse.
  effectiveMode,
};
