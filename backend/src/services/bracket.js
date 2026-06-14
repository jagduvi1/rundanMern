// BracketService — knockout tournaments for Boule activities (port of
// Rundan.Server/Services/BracketService.cs).
//
// Single-elimination bracket with an optional round-robin group stage. A bracket
// belongs to one Boule activity. Two playoff "pools": pool 0 = Playoff A
// (championship), pool 1 = Playoff B (plate). Each pool has a Winners side and an
// optional Losers (consolation) side. An optional group stage plays first, then
// seeds A and (optionally) B from the standings.
//
// A team's activity score (fed to the scoreboard + event placement) is either
// points-per-win or a final-placement value, per Activity.tournamentScoring.
//
// Persistence model: one BracketMatch doc per match (group OR knockout).
// Participant ids on a match are LOOSE refs (no FK) — guard against deleted
// participants (a ref may resolve to null).

const { BracketMatch, Activity, Participant, ScoreEntry } = require('../models');
const { idStr } = require('./serializers');
const {
  BracketSide, MatchFormat, TournamentScoring, ActivityType, ActivityStatus,
} = require('../constants/enums');
const { RuleViolation } = require('../middleware/error');

// ── Small helpers ─────────────────────────────────────────────────────────────

// Compare two (possibly null) ObjectId-ish values for equality by string form.
const sameId = (a, b) => {
  if (a == null || b == null) return false;
  return idStr(a) === idStr(b);
};

// In-place Fisher-Yates shuffle (the draw uses live RNG — not reproducible, but
// the drawn rows are persisted so reloads are stable, exactly like the .NET
// Random.Shared draw).
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Pure tournament math (mirrors the static C# helpers) ──────────────────────

// Suggests a group count aiming for ~4 teams a group.
function suggestGroupCount(teamCount) {
  if (teamCount < 4) return 1;
  // .NET MidpointRounding.AwayFromZero — team counts are positive so Math.round
  // (which rounds .5 up) matches.
  const g = Math.round(teamCount / 4.0);
  return Math.min(Math.max(g, 1), Math.floor(teamCount / 2));
}

// Total games for each side across the sets (e.g. "13-7,9-13" -> A=22, B=20). A
// win with no score recorded (simulated) counts as a 1-0.
function splitGames(raw) {
  if (!raw || !raw.trim()) return { a: 1, b: 0 };
  let a = 0;
  let b = 0;
  for (const set of raw.split(',')) {
    const trimmed = set.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('-').map((p) => p.trim());
    if (parts.length === 2) {
      const sa = Number.parseInt(parts[0], 10);
      const sb = Number.parseInt(parts[1], 10);
      if (Number.isFinite(sa) && Number.isFinite(sb)) {
        a += sa;
        b += sb;
      }
    }
  }
  return { a, b };
}

// "13-7,9-13,13-10" -> "13–7, 9–13, 13–10" (en dash U+2013, ", " join). Blank -> null.
function formatScore(raw) {
  if (!raw || !raw.trim()) return null;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/-/g, '–'))
    .join(', ');
}

// Decides the winner from entered scores, per the given match format. Returns the
// winning team id (aId or bId). Throws RuleViolation on an undecided/tied result.
function deriveWinner(format, bestOfSets, sets, aId, bId) {
  if (format === MatchFormat.Sets) {
    const aSets = sets.filter((s) => s.a > s.b).length;
    const bSets = sets.filter((s) => s.b > s.a).length;
    const need = Math.floor(Math.max(1, bestOfSets) / 2) + 1;
    if (aSets < need && bSets < need) {
      throw new RuleViolation(
        `No team has won enough sets yet — first to ${need} set${need === 1 ? '' : 's'} wins.`
      );
    }
    return aSets >= need ? aId : bId;
  }
  // Free scoring: a single score, higher wins.
  const { a: sa, b: sb } = sets[0];
  if (sa === sb) {
    throw new RuleViolation("A match can't end in a tie — one team must score more.");
  }
  return sa > sb ? aId : bId;
}

// Maps seeded teams onto standard bracket slot order (seed 1 top, seed 2 bottom,
// …); null where the seed number exceeds the team count (a bye). Reproduces the
// canonical 1/16/8/9/5/12/4/13/… serpentine seeding.
function seededTeamSlots(orderedTeams) {
  const n = orderedTeams.length;
  let size = 1;
  while (size < n) size <<= 1;

  let seeds = [1, 2];
  while (seeds.length < size) {
    const sum = seeds.length * 2 + 1;
    const next = [];
    for (const s of seeds) {
      next.push(s);
      next.push(sum - s);
    }
    seeds = next;
  }

  return seeds.map((s) => (s <= n ? orderedTeams[s - 1] : null));
}

// ── Group standings (pure over the loaded group matches) ──────────────────────

// Computes each group's table and marks which playoff (if any) each position
// advances to. groupMatches: array of plain BracketMatch docs with groupIndex !=
// null. Returns [{ groupIndex, rows: [GroupRow] }] where each row carries teamId
// (string), played, won, lost, pointsFor, pointsAgainst, diff, rank, advancesToPool.
function computeStandings(activity, groupMatches) {
  const groups = [];

  // Group the matches by groupIndex, ascending.
  const byGroup = new Map();
  for (const m of groupMatches) {
    const gi = m.groupIndex;
    if (!byGroup.has(gi)) byGroup.set(gi, []);
    byGroup.get(gi).push(m);
  }
  const groupKeys = [...byGroup.keys()].sort((x, y) => x - y);

  for (const gi of groupKeys) {
    const grp = byGroup.get(gi);

    // Distinct team ids across the group's matches (as strings; ignore null refs).
    const rows = new Map(); // teamId(string) -> row
    const ensure = (id) => {
      const key = idStr(id);
      if (key == null) return null;
      if (!rows.has(key)) {
        rows.set(key, {
          teamId: key,
          played: 0,
          won: 0,
          lost: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          diff: 0,
          rank: 0,
          advancesToPool: null,
        });
      }
      return rows.get(key);
    };
    for (const m of grp) {
      ensure(m.participantAId);
      ensure(m.participantBId);
    }

    // Tally each decided, non-bye match.
    for (const m of grp) {
      if (!m.winnerParticipantId || m.isBye) continue;
      const aKey = idStr(m.participantAId);
      const bKey = idStr(m.participantBId);
      if (aKey == null || bKey == null) continue;
      const a = rows.get(aKey);
      const b = rows.get(bKey);
      if (!a || !b) continue;
      const { a: ga, b: gb } = splitGames(m.setScores);
      a.played += 1;
      b.played += 1;
      a.pointsFor += ga;
      a.pointsAgainst += gb;
      b.pointsFor += gb;
      b.pointsAgainst += ga;
      if (sameId(m.winnerParticipantId, m.participantAId)) {
        a.won += 1;
        b.lost += 1;
      } else {
        b.won += 1;
        a.lost += 1;
      }
    }

    // Finalise diff and order: won desc, diff desc, pointsFor desc, teamId asc.
    const ordered = [...rows.values()];
    for (const r of ordered) r.diff = r.pointsFor - r.pointsAgainst;
    ordered.sort((x, y) => (
      y.won - x.won
      || y.diff - x.diff
      || y.pointsFor - x.pointsFor
      || (x.teamId < y.teamId ? -1 : x.teamId > y.teamId ? 1 : 0)
    ));

    const aAdvance = Math.max(1, activity.advanceToPlayoffA);
    const bAdvance = Math.max(0, activity.advanceToPlayoffB);
    // Cap Playoff A at the actual group size, then take Playoff B from the
    // leftover ranks.
    const aTake = Math.min(aAdvance, ordered.length);
    for (let i = 0; i < ordered.length; i += 1) {
      const rank = i + 1;
      ordered[i].rank = rank;
      ordered[i].advancesToPool = rank <= aTake ? 0
        : rank <= aTake + bAdvance ? 1
          : null;
    }

    groups.push({ groupIndex: gi, rows: ordered });
  }

  // A plate (Playoff B) needs at least two teams. If only one team would advance
  // across all groups, drop the promise so the "→ B" badge stays in lock-step
  // with the seeded bracket (which only builds B with >= 2).
  const bRows = groups.flatMap((g) => g.rows).filter((r) => r.advancesToPool === 1);
  if (bRows.length < 2) {
    for (const r of bRows) r.advancesToPool = null;
  }

  return groups;
}

// Cross-group seed list for a pool: the rows computeStandings marked as advancing
// there, ordered by rank asc (all rank-1 qualifiers first), then won desc, diff
// desc, pointsFor desc, teamId asc. Returns team id strings.
function seedsForPool(standings, pool) {
  return standings
    .flatMap((g) => g.rows)
    .filter((r) => r.advancesToPool === pool)
    .sort((x, y) => (
      x.rank - y.rank
      || y.won - x.won
      || y.diff - x.diff
      || y.pointsFor - x.pointsFor
      || (x.teamId < y.teamId ? -1 : x.teamId > y.teamId ? 1 : 0)
    ))
    .map((r) => r.teamId);
}

// ── Match-row construction (build new BracketMatch docs in memory) ────────────

// Sequential pairing (legacy/unseeded draw + follow-on rounds): (0,1),(2,3),…
// trailing odd team gets a bye. Returns an array of plain objects to insert.
function buildRound(activityId, pool, side, round, teamIds) {
  const docs = [];
  let slot = 0;
  for (let i = 0; i < teamIds.length; i += 2) {
    const bTeam = i + 1 < teamIds.length ? teamIds[i + 1] : null;
    docs.push({
      activityId,
      pool,
      groupIndex: null,
      side,
      round,
      slot,
      participantAId: teamIds[i],
      participantBId: bTeam,
      isBye: bTeam == null,
      // A bye auto-advances the present team.
      winnerParticipantId: bTeam == null ? teamIds[i] : null,
      setScores: null,
      courtId: null,
    });
    slot += 1;
  }
  return docs;
}

// Seeded round 1: standard bracket positions so seed 1 meets the lowest seed and
// the top seeds get the byes. Falls back to sequential pairing when unseeded or
// fewer than two teams. Returns an array of plain objects to insert.
function buildKnockoutRound1(activityId, pool, orderedTeams, seeded) {
  if (!seeded || orderedTeams.length < 2) {
    return buildRound(activityId, pool, BracketSide.Winners, 1, orderedTeams);
  }

  const slots = seededTeamSlots(orderedTeams); // length = next power of two; null = bye
  const docs = [];
  let slot = 0;
  for (let i = 0; i < slots.length; i += 2) {
    let a = slots[i];
    let b = slots[i + 1];
    if (a == null && b != null) {
      // Keep the present team as A so a bye reads "team vs (walkover)".
      [a, b] = [b, a];
    }
    docs.push({
      activityId,
      pool,
      groupIndex: null,
      side: BracketSide.Winners,
      round: 1,
      slot,
      participantAId: a,
      participantBId: b,
      isBye: b == null,
      winnerParticipantId: b == null ? a : null,
      setScores: null,
      courtId: null,
    });
    slot += 1;
  }
  return docs;
}

// Snake-distributes the seeded order across g groups then builds a round-robin
// (circle method) per group. Returns an array of plain objects to insert.
function buildGroups(activity, seededTeams) {
  const n = seededTeams.length;
  let g = activity.groupCount > 0 ? activity.groupCount : suggestGroupCount(n);
  g = Math.min(Math.max(g, 1), Math.floor(n / 2));

  // Snake distribution (boustrophedon) so the strongest teams spread across groups.
  const groups = Array.from({ length: g }, () => []);
  let gi = 0;
  let forward = true;
  for (const team of seededTeams) {
    groups[gi].push(team);
    if (forward) {
      if (gi === g - 1) forward = false;
      else gi += 1;
    } else if (gi === 0) forward = true;
    else gi -= 1;
  }

  const docs = [];
  for (let index = 0; index < groups.length; index += 1) {
    docs.push(...buildRoundRobin(activity._id, index, groups[index]));
  }
  return docs;
}

// Circle method: every team plays every other once. round = "matchday" (used for
// court scheduling spread). Returns an array of plain objects to insert.
function buildRoundRobin(activityId, groupIndex, teams) {
  const rotation = teams.slice();
  if (rotation.length % 2 === 1) rotation.push(null); // odd team rests each matchday

  const m = rotation.length;
  const rounds = m - 1;
  const half = m / 2;
  const docs = [];

  for (let r = 1; r <= rounds; r += 1) {
    let slot = 0;
    for (let i = 0; i < half; i += 1) {
      const a = rotation[i];
      const b = rotation[m - 1 - i];
      if (a != null && b != null) {
        docs.push({
          activityId,
          groupIndex,
          pool: 0,
          side: BracketSide.Winners,
          round: r,
          slot,
          participantAId: a,
          participantBId: b,
          isBye: false,
          winnerParticipantId: null,
          setScores: null,
          courtId: null,
        });
        slot += 1;
      }
    }
    // Rotate all but the first element clockwise.
    const last = rotation[m - 1];
    for (let i = m - 1; i > 1; i -= 1) rotation[i] = rotation[i - 1];
    rotation[1] = last;
  }
  return docs;
}

// ── Court assignment (deterministic spread) ───────────────────────────────────

// Spreads matches evenly across the activity's courts following the
// order-of-play sequence, so matches in the same wave land on different courts.
// Byes take no court. Deterministic, so a decided match keeps its court label.
async function assignCourts(activity) {
  const courtIds = (activity.courts || [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((c) => c._id);
  if (courtIds.length === 0) return;

  const matches = await BracketMatch.find({ activityId: activity._id });
  matches.sort((a, b) => (
    (a.groupIndex != null ? a.groupIndex : 1000) - (b.groupIndex != null ? b.groupIndex : 1000)
    || a.round - b.round
    || a.pool - b.pool
    || a.side - b.side
    || a.slot - b.slot
  ));

  let played = 0;
  const ops = [];
  for (const m of matches) {
    let courtId;
    if (m.isBye) {
      courtId = null;
    } else {
      courtId = courtIds[played % courtIds.length];
      played += 1;
    }
    const newVal = courtId == null ? null : idStr(courtId);
    const curVal = m.courtId == null ? null : idStr(m.courtId);
    if (newVal !== curVal) {
      ops.push({ updateOne: { filter: { _id: m._id }, update: { $set: { courtId } } } });
    }
  }
  if (ops.length) await BracketMatch.bulkWrite(ops);
}

// ── Advancement (build follow-on knockout rounds) ─────────────────────────────

// One advancement step for a pool: seed its losers' side, or build the next round
// of a side. Returns true if it inserted anything.
async function tryAdvancePool(activity, pool, poolMatches) {
  const consolation = pool === 0 ? activity.playoffAConsolation : activity.playoffBConsolation;

  // Seed the losers' side once from the winners' round-1 losers.
  if (consolation && !poolMatches.some((m) => m.side === BracketSide.Losers)) {
    const w1 = poolMatches.filter((m) => m.side === BracketSide.Winners && m.round === 1);
    if (w1.length > 0 && w1.every((m) => m.winnerParticipantId != null)) {
      const losers = w1
        .filter((m) => !m.isBye)
        .sort((a, b) => a.slot - b.slot)
        .map((m) => (sameId(m.winnerParticipantId, m.participantAId)
          ? m.participantBId
          : m.participantAId))
        .filter((id) => id != null);
      if (losers.length >= 2) {
        await BracketMatch.insertMany(buildRound(activity._id, pool, BracketSide.Losers, 1, losers));
        return true;
      }
    }
  }

  // Advance a side whose latest complete round produced more than one survivor.
  for (const side of [BracketSide.Winners, BracketSide.Losers]) {
    const sideMatches = poolMatches.filter((m) => m.side === side);
    if (sideMatches.length === 0) continue;
    const maxRound = Math.max(...sideMatches.map((m) => m.round));
    for (let r = 1; r <= maxRound; r += 1) {
      const round = sideMatches.filter((m) => m.round === r).sort((a, b) => a.slot - b.slot);
      if (round.length === 0 || !round.every((m) => m.winnerParticipantId != null)) continue;
      const survivors = round.map((m) => m.winnerParticipantId);
      if (survivors.length >= 2 && !sideMatches.some((m) => m.round === r + 1)) {
        await BracketMatch.insertMany(buildRound(activity._id, pool, side, r + 1, survivors));
        return true;
      }
    }
  }

  return false;
}

// Builds follow-on knockout rounds as results come in, per pool, then reassigns
// courts. Loops until no pool acts (a single result can cascade several rounds).
async function advance(activity) {
  // Guard the loop (a full group stage + two playoff brackets is bounded).
  for (let guard = 0; guard < 1000; guard += 1) {
    // eslint-disable-next-line no-await-in-loop
    const knockout = await BracketMatch.find({ activityId: activity._id, groupIndex: null });
    if (knockout.length === 0) break; // group stage only, so far

    const pools = [...new Set(knockout.map((m) => m.pool))].sort((a, b) => a - b);
    let acted = false;
    for (const pool of pools) {
      // eslint-disable-next-line no-await-in-loop
      if (await tryAdvancePool(activity, pool, knockout.filter((m) => m.pool === pool))) {
        acted = true;
        break;
      }
    }
    if (!acted) break;
  }

  await assignCourts(activity);
}

// Once every group match is decided, seeds Playoff A and (optionally) B from the
// standings. Returns true if it seeded.
async function trySeedPlayoffs(activity) {
  const all = await BracketMatch.find({ activityId: activity._id });

  // Already seeded once a knockout match exists.
  if (all.some((m) => m.groupIndex == null)) return false;

  const groupMatches = all.filter((m) => m.groupIndex != null);
  if (groupMatches.length === 0
    || !groupMatches.every((m) => m.winnerParticipantId != null || m.isBye)) {
    return false;
  }

  const standings = computeStandings(activity, groupMatches);
  const aSeeds = seedsForPool(standings, 0);
  const bSeeds = seedsForPool(standings, 1);

  const toInsert = [];
  if (aSeeds.length >= 1) toInsert.push(...buildKnockoutRound1(activity._id, 0, aSeeds, true));
  if (bSeeds.length >= 2) toInsert.push(...buildKnockoutRound1(activity._id, 1, bSeeds, true));
  if (toInsert.length) await BracketMatch.insertMany(toInsert);
  return true;
}

// ── Scoring (the bracket fully owns this activity's ScoreEntry lines) ─────────

// Points per win: group win = 1; Playoff A win = 3 (consolation 1); Playoff B win
// = 2 (consolation 1). Returns Map<teamId(string), points>.
function perWinPoints(matches) {
  const points = new Map();
  for (const m of matches) {
    const w = idStr(m.winnerParticipantId);
    if (w == null) continue;
    const award = m.groupIndex != null ? 1
      : m.pool === 0 ? (m.side === BracketSide.Winners ? 3 : 1)
        : (m.side === BracketSide.Winners ? 2 : 1);
    points.set(w, (points.get(w) || 0) + award);
  }
  return points;
}

// Final placement: rank every team by how far it got (champion first), award
// position points (1st = team count). Returns Map<teamId(string), points>.
function placementPoints(matches) {
  const teamIds = [];
  const seen = new Set();
  for (const m of matches) {
    for (const id of [m.participantAId, m.participantBId]) {
      const key = idStr(id);
      if (key != null && !seen.has(key)) {
        seen.add(key);
        teamIds.push(key);
      }
    }
  }
  if (teamIds.length === 0) return new Map();

  const knockout = matches.filter((m) => m.groupIndex == null);
  const inMatch = (m, team) => sameId(m.participantAId, team) || sameId(m.participantBId, team);

  // Achievement score sorting champions first: pool tier ≫ winners' depth ≫ wins
  // ≫ group form.
  const achievement = (team) => {
    const inA = knockout.some((m) => m.pool === 0 && inMatch(m, team));
    const inB = knockout.some((m) => m.pool === 1 && inMatch(m, team));
    const tier = inA ? 1000000 : inB ? 100000 : 0;

    const winnersRounds = knockout
      .filter((m) => m.side === BracketSide.Winners && inMatch(m, team))
      .map((m) => m.round);
    const winnersReached = winnersRounds.length ? Math.max(...winnersRounds) : 0;
    const winnersWins = knockout.filter((m) => m.side === BracketSide.Winners
      && sameId(m.winnerParticipantId, team)).length;
    const losersWins = knockout.filter((m) => m.side === BracketSide.Losers
      && sameId(m.winnerParticipantId, team)).length;
    const groupWins = matches.filter((m) => m.groupIndex != null
      && sameId(m.winnerParticipantId, team)).length;

    return tier + winnersReached * 1000 + winnersWins * 100 + losersWins * 10 + groupWins;
  };

  const ranked = teamIds
    .map((id) => ({ id, score: achievement(id) }))
    .sort((x, y) => (y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)));

  const points = new Map();
  const n = ranked.length;
  for (let i = 0; i < n; i += 1) points.set(ranked[i].id, n - i); // 1st = n, last = 1
  return points;
}

// Rebuilds this activity's ScoreEntry lines from the decided, non-bye results.
async function recomputeScores(activity) {
  const matches = await BracketMatch.find({
    activityId: activity._id,
    isBye: false,
    winnerParticipantId: { $ne: null },
  });

  const points = activity.tournamentScoring === TournamentScoring.Placement
    ? placementPoints(matches)
    : perWinPoints(matches);

  // The bracket fully owns this activity's score lines — wipe and rebuild.
  await ScoreEntry.deleteMany({ activityId: activity._id });
  const now = new Date();
  const docs = [];
  for (const [participantId, pts] of points.entries()) {
    if (pts > 0) {
      docs.push({
        activityId: activity._id,
        participantId,
        round: 1,
        points: pts,
        recordedUtc: now,
      });
    }
  }
  if (docs.length) await ScoreEntry.insertMany(docs);
}

// ── View model (BracketDto) ───────────────────────────────────────────────────

// Champion of a pool = the winner of the single match in its top winners' round.
// `knockout` is the array of knockout matches, `name` resolves a participant id.
function poolChampion(knockout, pool, name) {
  const w = knockout.filter((m) => m.pool === pool && m.side === BracketSide.Winners);
  if (w.length === 0) return null;
  const top = Math.max(...w.map((m) => m.round));
  const final = w.filter((m) => m.round === top);
  return final.length === 1 && final[0].winnerParticipantId != null
    ? name(final[0].winnerParticipantId)
    : null;
}

/**
 * Builds the BracketDto view for an activity.
 * @param {string|ObjectId} activityId
 * @returns {Promise<object|null>} BracketDto, or null if the activity is missing.
 *   Shape: { activityId, drawn, complete, championName, playoffBChampionName,
 *   hasGroupStage, groupStageComplete, groups: [GroupStandingDto], matches:
 *   [BracketMatchDto] }. Each BracketMatchDto adds computed ready/decided.
 */
async function getBracketDto(activityId) {
  const activity = await Activity.findById(activityId);
  if (!activity) return null;

  const matches = await BracketMatch.find({ activityId: activity._id });
  matches.sort((a, b) => (
    a.pool - b.pool || a.side - b.side || a.round - b.round || a.slot - b.slot
  ));

  // Name + court lookups (guard against deleted participants → null).
  const parts = await Participant.find({ activityId: activity._id }).select('displayName');
  const nameMap = new Map(parts.map((p) => [idStr(p._id), p.displayName]));
  const courtMap = new Map((activity.courts || []).map((c) => [idStr(c._id), c.name]));
  const name = (id) => (id != null && nameMap.has(idStr(id)) ? nameMap.get(idStr(id)) : null);
  const court = (id) => (id != null && courtMap.has(idStr(id)) ? courtMap.get(idStr(id)) : null);

  const groupMatches = matches.filter((m) => m.groupIndex != null);
  const knockout = matches.filter((m) => m.groupIndex == null);

  const hasGroupStage = !!activity.useGroupStage && groupMatches.length > 0;
  const groupStageComplete = groupMatches.length > 0
    && groupMatches.every((m) => m.winnerParticipantId != null || m.isBye)
    && knockout.length > 0;

  const matchDtos = matches.map((m) => {
    const aId = m.participantAId ? idStr(m.participantAId) : null;
    const bId = m.participantBId ? idStr(m.participantBId) : null;
    return {
      id: idStr(m._id),
      pool: m.pool,
      groupIndex: m.groupIndex,
      side: m.side,
      round: m.round,
      slot: m.slot,
      aId,
      aName: name(m.participantAId),
      bId,
      bName: name(m.participantBId),
      winnerParticipantId: m.winnerParticipantId ? idStr(m.winnerParticipantId) : null,
      isBye: m.isBye,
      courtName: court(m.courtId),
      score: formatScore(m.setScores),
      // Computed (mirror BracketMatchDto.Ready/Decided).
      ready: aId != null && bId != null && !m.isBye,
      decided: m.winnerParticipantId != null,
    };
  });

  let groups = [];
  if (groupMatches.length > 0) {
    groups = computeStandings(activity, groupMatches).map((g) => ({
      groupIndex: g.groupIndex,
      rows: g.rows.map((r) => ({
        teamId: r.teamId,
        name: name(r.teamId) || '—',
        played: r.played,
        won: r.won,
        lost: r.lost,
        pointsFor: r.pointsFor,
        pointsAgainst: r.pointsAgainst,
        diff: r.diff,
        rank: r.rank,
        advancesToPool: r.advancesToPool,
      })),
    }));
  }

  const championName = poolChampion(knockout, 0, name);
  const playoffBChampionName = poolChampion(knockout, 1, name);

  const seededOk = !hasGroupStage || groupStageComplete;
  const complete = seededOk
    && knockout.length > 0
    && championName != null
    && knockout.every((m) => m.winnerParticipantId != null || m.isBye);

  return {
    activityId: idStr(activity._id),
    drawn: matches.length > 0,
    complete,
    championName,
    playoffBChampionName,
    hasGroupStage,
    groupStageComplete,
    groups,
    matches: matchDtos,
  };
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Draws the tournament for an activity (group stage and/or knockout). Persists
 * BracketMatch docs. No-op (returns false) if any match already exists.
 * @param {object} activity A loaded Activity Mongoose doc.
 * @returns {Promise<boolean>} true if it drew, false if already drawn.
 */
async function drawBracket(activity) {
  if (await BracketMatch.exists({ activityId: activity._id })) return false; // already drawn

  const teamRows = await Participant.find({ activityId: activity._id, isTeam: true })
    .select('seed');
  if (teamRows.length < 2) {
    throw new RuleViolation('Need at least two teams to draw the tournament.');
  }

  // Seed order: manual seeds first (1 = top), then a random shuffle of the rest;
  // a plain random order when manual seeding is off.
  let ordered;
  if (activity.useManualSeeding) {
    // orderBy(seed ?? +∞) thenBy(random): pre-shuffle, then stable-sort by seed.
    const shuffled = shuffle(teamRows.slice());
    shuffled.sort((a, b) => {
      const sa = a.seed == null ? Number.POSITIVE_INFINITY : a.seed;
      const sb = b.seed == null ? Number.POSITIVE_INFINITY : b.seed;
      return sa - sb;
    });
    ordered = shuffled.map((t) => t._id);
  } else {
    ordered = shuffle(teamRows.slice()).map((t) => t._id);
  }

  if (activity.useGroupStage) {
    const docs = buildGroups(activity, ordered);
    if (docs.length) await BracketMatch.insertMany(docs);
    await assignCourts(activity);
  } else {
    const docs = buildKnockoutRound1(activity._id, 0, ordered, activity.useManualSeeding);
    if (docs.length) await BracketMatch.insertMany(docs);
    await advance(activity); // resolves first-round byes, seeds losers, assigns courts
  }

  return true;
}

/**
 * Sets the manual seed order (team ids ranked 1→N). Teams left out are unseeded
 * (seed = null).
 * @param {object} activity A loaded Activity Mongoose doc.
 * @param {Array<string|ObjectId>} teamIdsInOrder First entry = seed 1.
 */
async function setSeeds(activity, teamIdsInOrder) {
  const rank = new Map();
  (teamIdsInOrder || []).forEach((id, i) => rank.set(idStr(id), i + 1));

  const teams = await Participant.find({ activityId: activity._id, isTeam: true }).select('_id');
  const ops = teams.map((t) => ({
    updateOne: {
      filter: { _id: t._id },
      update: { $set: { seed: rank.has(idStr(t._id)) ? rank.get(idStr(t._id)) : null } },
    },
  }));
  if (ops.length) await Participant.bulkWrite(ops);
}

/**
 * Records a match result, derives the winner, advances the bracket, and rebuilds
 * the activity's score lines. Provide `sets` (player flow) OR `explicitWinnerId`
 * (simulation path). A decided match is final.
 * @param {object} activity A loaded Activity Mongoose doc.
 * @param {object} input
 * @param {string|ObjectId} input.matchId
 * @param {Array<{a:number,b:number}>} [input.sets] One entry per set ({a,b}); a
 *   single entry for free scoring. Winner derived per match format.
 * @param {string|ObjectId} [input.explicitWinnerId] Winner id (no scores stored).
 */
async function recordResult(activity, { matchId, sets, explicitWinnerId } = {}) {
  const match = await BracketMatch.findOne({ _id: matchId, activityId: activity._id });
  if (!match) throw new RuleViolation('Match not found.', 404);
  if (match.isBye) throw new RuleViolation('That match is a walkover.');
  // A decided match is final — re-recording can't safely re-seed built rounds.
  if (match.winnerParticipantId != null) {
    throw new RuleViolation('That match result is already recorded.', 409);
  }
  if (match.participantAId == null || match.participantBId == null) {
    throw new RuleViolation("That match isn't ready to be played yet.");
  }

  const aId = match.participantAId;
  const bId = match.participantBId;

  let winnerId;
  let scores = null;
  if (Array.isArray(sets) && sets.length > 0) {
    // Group matches use the group-stage format; knockout uses the playoff format.
    const isGroup = match.groupIndex != null;
    const format = isGroup ? activity.groupMatchFormat : activity.matchFormat;
    const bestOf = isGroup ? activity.groupBestOfSets : activity.bestOfSets;
    // Normalise set inputs to numbers.
    const normSets = sets.map((s) => ({ a: Number(s.a), b: Number(s.b) }));
    winnerId = deriveWinner(format, bestOf, normSets, aId, bId);
    scores = normSets.map((s) => `${s.a}-${s.b}`).join(',');
  } else if (explicitWinnerId != null) {
    winnerId = explicitWinnerId;
  } else {
    throw new RuleViolation('Enter the match result.');
  }

  if (!sameId(winnerId, aId) && !sameId(winnerId, bId)) {
    throw new RuleViolation('The winner must be one of the two teams in the match.');
  }

  match.winnerParticipantId = winnerId;
  match.setScores = scores;
  await match.save();

  // A finished group stage seeds the playoffs; then build out knockout rounds.
  if (match.groupIndex != null) await trySeedPlayoffs(activity);
  await advance(activity);
  await recomputeScores(activity);
}

/**
 * Deletes all BracketMatch docs and all ScoreEntry rows for the activity (the
 * bracket owns those score lines).
 * @param {object} activity A loaded Activity Mongoose doc (or anything with _id).
 */
async function resetBracket(activity) {
  await BracketMatch.deleteMany({ activityId: activity._id });
  await ScoreEntry.deleteMany({ activityId: activity._id });
}

/**
 * If the tournament has crowned its champion(s), finish the activity. Call after
 * recordResult. Only acts on a Boule activity in the Live state.
 * @param {object} activity A loaded Activity Mongoose doc.
 * @returns {Promise<boolean>} true if it finished the activity.
 */
async function tryAutoFinish(activity) {
  if (activity.type !== ActivityType.Boule || activity.status !== ActivityStatus.Live) {
    return false;
  }
  const bracket = await getBracketDto(activity._id);
  if (!bracket || bracket.complete !== true) return false;

  activity.status = ActivityStatus.Finished;
  activity.finishedUtc = new Date();
  await activity.save();
  return true;
}

/**
 * Scoreboard entry rows for a Boule activity — called BY the scoreboard service.
 * Reflects Activity.tournamentScoring (PerWin/Placement): the same point map the
 * bracket persists to ScoreEntry, surfaced as ranked rows.
 *
 * @param {object} activity A loaded Activity Mongoose doc.
 * @returns {Promise<Array<{participantId:string, displayName:string, rank:number,
 *   totalPoints:number, entries:number}>>} One row per team that has any team
 *   participant, ranked by points desc (ties share the higher rank; competition
 *   ranking 1,1,3). `entries` = number of decided non-bye matches the team won
 *   (the count of score lines that fed its total). Teams with no points are
 *   included with totalPoints 0 and ranked last (alphabetical tiebreak).
 */
async function bracketScoreboardEntries(activity) {
  const teams = await Participant.find({ activityId: activity._id, isTeam: true })
    .select('displayName');

  const matches = await BracketMatch.find({
    activityId: activity._id,
    isBye: false,
    winnerParticipantId: { $ne: null },
  });

  const points = activity.tournamentScoring === TournamentScoring.Placement
    ? placementPoints(matches)
    : perWinPoints(matches);

  // Count of winning matches per team (the number of score-contributing results).
  const winCounts = new Map();
  for (const m of matches) {
    const w = idStr(m.winnerParticipantId);
    if (w != null) winCounts.set(w, (winCounts.get(w) || 0) + 1);
  }

  const rows = teams.map((t) => {
    const id = idStr(t._id);
    return {
      participantId: id,
      displayName: t.displayName,
      totalPoints: points.get(id) || 0,
      entries: winCounts.get(id) || 0,
    };
  });

  // Competition ranking: points desc, then displayName CI; ties share the higher
  // rank, the next distinct score jumps to its positional rank (1,1,3).
  rows.sort((x, y) => (
    y.totalPoints - x.totalPoints
    || x.displayName.localeCompare(y.displayName, undefined, { sensitivity: 'accent' })
  ));
  let lastPoints = null;
  let lastRank = 0;
  rows.forEach((r, i) => {
    if (lastPoints === null || r.totalPoints !== lastPoints) {
      lastRank = i + 1;
      lastPoints = r.totalPoints;
    }
    r.rank = lastRank;
  });

  return rows;
}

module.exports = {
  getBracketDto,
  drawBracket,
  setSeeds,
  recordResult,
  resetBracket,
  tryAutoFinish,
  bracketScoreboardEntries,
  // Exposed for tests / reuse by sibling services.
  suggestGroupCount,
  computeStandings,
  perWinPoints,
  placementPoints,
};
