// Combined event standings — the MERN port of rundan's `EventStandingsService.cs`.
// Computes every player's total across all of an event's activities under either
// scoring model:
//   - Cumulative: sum the actual points each team scored.
//   - Placement:  in each FINISHED activity, rank teams and award position points
//                 (1st = #participants, then descending by 1; ties share the
//                 higher points), credited to each member.
// A team's points are always credited to EACH of its member users individually.
//
// Ranking goes through scoring.* so the standings and the live scoreboard agree.
const {
  Event, EventMember, Activity, Participant, Answer, ScoreEntry, Slap,
} = require('../models');
const { EventScoring, ActivityStatus } = require('../constants/enums');
const scoring = require('./scoring');
const { idStr } = require('./serializers');

// Single injectable clock for the `updatedUtc` stamp.
const now = () => new Date();

/**
 * Build the combined standings for an event.
 *
 * @param {*} eventId  Mongo _id (string or ObjectId).
 * @returns {Promise<object|null>} EventStandingsDto, or `null` if the event is
 *   missing:
 *   {
 *     eventId, name,
 *     entries: [{ userId, displayName, rank, totalPoints,
 *                 activitiesPlayed, slapLost, slapReceived }],
 *     updatedUtc
 *   }
 *   (`userId` is null for free-name events — mirrors the C# sentinel 0.)
 */
async function buildStandings(eventId) {
  const ev = await Event.findById(eventId).lean();
  if (!ev) return null;

  // Roster = the users selected into the event (EventMembers).
  const members = await EventMember.find({ eventId: ev._id })
    .select('userId')
    .populate('userId', 'name')
    .lean();
  const roster = members
    .filter((m) => m.userId) // defensive against a deleted user ref
    .map((m) => ({ userId: idStr(m.userId), name: m.userId.name }));

  const entries = roster.length > 0
    ? await buildRoster(ev, roster)
    : await buildFreeName(ev);

  rankEntries(entries);

  return {
    eventId: idStr(ev),
    name: ev.name,
    entries,
    updatedUtc: now(),
  };
}

// ── Shared: points + participants for an event ────────────────────────────────

// Returns the activities of an event keyed by id-string for placement, plus the
// raw list and an array of their ObjectIds (for queries).
async function loadEventActivities(eventId) {
  const activities = await Activity.find({ eventId })
    .select('_id status scoringMode targetValue')
    .lean();
  return activities;
}

// Sum of answer points + score points per participant across the whole event.
// Returns a Map<participantIdStr, number>. CRUCIALLY the map's KEYS double as the
// "this participant actually recorded something" set: a participant absent from
// the map recorded nothing, while one whose rows net to 0 is still PRESENT (key
// inserted even when adding 0). Never pre-filter zero rows.
async function pointsByParticipant(activityIds) {
  const points = new Map();
  const add = (pid, value) => {
    const key = idStr(pid);
    points.set(key, (points.get(key) || 0) + value);
  };

  // Scope to this event's participants up front, then sum answer points per
  // participant IN THE DB. The old shape $lookup-joined the ENTIRE Answer
  // collection to Participant before filtering — an unbounded scan that grew with
  // every event's answers. Matching on participantId first (index-driven on
  // Answer.participantId) keeps it proportional to this event. A participant whose
  // answers net to 0 still appears (group emits a 0 row → key inserted); one with
  // no answer rows is absent — preserving the "recorded something" key semantics.
  const partIds = await Participant.find({ activityId: { $in: activityIds } }).distinct('_id');
  const [answerRows, scoreRows] = await Promise.all([
    partIds.length
      ? Answer.aggregate([
          { $match: { participantId: { $in: partIds } } },
          { $group: { _id: '$participantId', points: { $sum: '$awardedPoints' } } },
        ])
      : [],
    ScoreEntry.find({ activityId: { $in: activityIds } }).select('participantId points').lean(),
  ]);
  for (const r of answerRows) add(r._id, r.points || 0);
  // Score points — scoped directly by activityId.
  for (const r of scoreRows) add(r.participantId, r.points || 0);

  return points;
}

// ── Roster events ─────────────────────────────────────────────────────────────

async function buildRoster(ev, roster) {
  const activities = await loadEventActivities(ev._id);
  const activityIds = activities.map((a) => a._id);

  // points, the team participants, and the slap rows are independent — fetch in
  // parallel. (Team participants carry their member user-ids in an embedded
  // `members` array, so no separate join collection.)
  const [points, teamParts, slaps] = await Promise.all([
    pointsByParticipant(activityIds),
    Participant.find({ activityId: { $in: activityIds }, isTeam: true })
      .select('_id activityId members')
      .lean(),
    Slap.find({ eventId: ev._id, skipped: false })
      .select('slappedUserId recipientUserId penalty')
      .lean(),
  ]);
  const membersByParticipant = new Map();
  for (const tp of teamParts) {
    membersByParticipant.set(
      idStr(tp),
      (tp.members || []).filter((m) => m.userId).map((m) => idStr(m.userId)),
    );
  }

  const totals = new Map();
  const played = new Map();
  for (const u of roster) {
    totals.set(u.userId, 0);
    played.set(u.userId, new Set());
  }

  // Credit a team participant's points to each of its member users. "Played"
  // means the team has rows for the activity (points.has) — NOT non-zero points.
  const credit = (participantId, pts, activityId) => {
    const users = membersByParticipant.get(idStr(participantId));
    if (!users) return;
    const participated = points.has(idStr(participantId));
    for (const uid of users) {
      if (!totals.has(uid)) continue;
      totals.set(uid, totals.get(uid) + pts);
      if (participated) played.get(uid).add(idStr(activityId));
    }
  };

  if (ev.scoring === EventScoring.Placement) {
    awardPlacement(activities, teamParts.map((t) => ({
      participantId: t._id, activityId: t.activityId,
    })), points, credit);
  } else {
    for (const t of teamParts) {
      credit(t._id, points.get(idStr(t._id)) || 0, t.activityId);
    }
  }

  // Slap penalties (roster only): the slapped player loses points; a "send" slap
  // gives them to a recipient. Track lost/received so the columns can be shown.
  const lost = new Map();
  const received = new Map();
  for (const u of roster) {
    lost.set(u.userId, 0);
    received.set(u.userId, 0);
  }
  for (const s of slaps) {
    const slapped = idStr(s.slappedUserId);
    const penalty = s.penalty || 0;
    if (slapped && totals.has(slapped)) {
      totals.set(slapped, totals.get(slapped) - penalty);
      lost.set(slapped, lost.get(slapped) + penalty);
    }
    const recipient = s.recipientUserId ? idStr(s.recipientUserId) : null;
    if (recipient && totals.has(recipient)) {
      totals.set(recipient, totals.get(recipient) + penalty);
      received.set(recipient, received.get(recipient) + penalty);
    }
  }

  return roster.map((u) => ({
    userId: u.userId,
    displayName: u.name,
    totalPoints: totals.get(u.userId),
    activitiesPlayed: played.get(u.userId).size,
    slapLost: lost.get(u.userId),
    slapReceived: received.get(u.userId),
    rank: 0,
  }));
}

// ── Free-name events (no roster) ──────────────────────────────────────────────

async function buildFreeName(ev) {
  const activities = await loadEventActivities(ev._id);
  const activityIds = activities.map((a) => a._id);

  // points and the participant list are independent — fetch together. Every
  // participant counts here (NOT filtered by isTeam). Identity = the DisplayName
  // string (case-sensitive ordinal), not a user id.
  const [points, parts] = await Promise.all([
    pointsByParticipant(activityIds),
    Participant.find({ activityId: { $in: activityIds } })
      .select('_id activityId displayName')
      .lean(),
  ]);

  const totals = new Map(); // name -> points
  const played = new Map(); // name -> Set<activityIdStr>
  for (const p of parts) {
    if (!totals.has(p.displayName)) {
      totals.set(p.displayName, 0);
      played.set(p.displayName, new Set());
    }
  }
  const nameByParticipant = new Map();
  for (const p of parts) nameByParticipant.set(idStr(p), p.displayName);

  const credit = (participantId, pts, activityId) => {
    const name = nameByParticipant.get(idStr(participantId));
    if (name === undefined) return;
    totals.set(name, (totals.get(name) || 0) + pts);
    if (points.has(idStr(participantId))) {
      played.get(name).add(idStr(activityId));
    }
  };

  if (ev.scoring === EventScoring.Placement) {
    awardPlacement(activities, parts.map((p) => ({
      participantId: p._id, activityId: p.activityId,
    })), points, credit);
  } else {
    for (const p of parts) {
      credit(p._id, points.get(idStr(p._id)) || 0, p.activityId);
    }
  }

  // No slaps in the free-name path. userId is null (C# uses sentinel 0).
  const result = [];
  for (const [name, total] of totals) {
    result.push({
      userId: null,
      displayName: name,
      totalPoints: total,
      activitiesPlayed: played.get(name).size,
      slapLost: 0,
      slapReceived: 0,
      rank: 0,
    });
  }
  return result;
}

// ── Placement awarding (per FINISHED activity) ────────────────────────────────

// Awards position points per finished activity: 1st = #participants in that
// activity, then descending by 1; ties share the higher (better) position.
// `participants` = [{ participantId, activityId }]; `credit(participantId, points,
// activityId)` is the per-model crediting closure.
function awardPlacement(activities, participants, points, credit) {
  const modeByActivity = new Map();
  const finished = new Set();
  for (const a of activities) {
    modeByActivity.set(idStr(a), {
      scoringMode: a.scoringMode,
      target: a.targetValue != null ? a.targetValue : 0,
    });
    if (a.status === ActivityStatus.Finished) finished.add(idStr(a));
  }

  // Group participants by activity.
  const groups = new Map();
  for (const p of participants) {
    const key = idStr(p.activityId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  for (const [activityKey, group] of groups) {
    if (!finished.has(activityKey)) continue; // placement counts once finished

    const n = group.length;
    const mode = modeByActivity.get(activityKey) || { scoringMode: undefined, target: 0 };
    const pushUnscoredLast = scoring.pushesUnscoredLast(mode.scoringMode);

    const ordered = group.map((p) => {
      const pid = idStr(p.participantId);
      return {
        participantId: p.participantId,
        score: points.get(pid) || 0,
        // A team that recorded nothing must not win a lowest/closest game with 0.
        unscored: pushUnscoredLast && !points.has(pid),
      };
    });

    const keyOf = (x) => scoring.rankKey(mode.scoringMode, x.score, mode.target);
    ordered.sort((a, b) => {
      if (a.unscored !== b.unscored) return a.unscored ? 1 : -1;
      const ka = keyOf(a);
      const kb = keyOf(b);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return 0;
    });

    // Competition ranking on `position` (ties share the higher position), then
    // credit `n - position + 1` points (1st -> n, last -> 1).
    let position = 0;
    let previousKey = null;
    let previousUnscored = null;
    let seen = 0;
    for (const entry of ordered) {
      seen += 1;
      const key = keyOf(entry);
      if (previousKey === null || key !== previousKey || entry.unscored !== previousUnscored) {
        position = seen;
        previousKey = key;
        previousUnscored = entry.unscored;
      }
      credit(entry.participantId, n - position + 1, group[0].activityId);
    }
  }
}

// ── Final standings ranking ───────────────────────────────────────────────────

// Sort by totalPoints DESC, then displayName (case-insensitive), and assign
// competition ranks on totalPoints only ("1, 1, 3" descending). Mutates in place.
function rankEntries(entries) {
  entries.sort((a, b) => {
    if (a.totalPoints !== b.totalPoints) return a.totalPoints > b.totalPoints ? -1 : 1;
    return scoring.compareNameCaseInsensitive(a.displayName, b.displayName);
  });
  scoring.assignCompetitionRanks(entries, (e) => e.totalPoints);
}

module.exports = {
  buildStandings,
  // Exported for tests / reuse; not part of the route surface.
  pointsByParticipant,
};
