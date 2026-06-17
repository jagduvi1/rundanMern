const express = require('express');
const crypto = require('crypto');

// EventEndpoints (/api/events) — the MERN port of rundan's EventEndpoints.cs
// (the core subset: create/list/get/update/delete, by-code lookup, members,
// code, reorder, bulk activity status, standings, teams, free-name join, roster
// claim, GPS arrive). Chat/push/viewers/slap live in their own route modules.
//
// Auth model (hybrid port): the original gated "admin" routes by a shared admin
// code; here they require a logged-in host (`requireAuth`) — `canManageEvent`
// resolves global-admin / owner / event-admin-member-token. Management routes use
// the `eventManager` middleware (404 if missing, 403 if not allowed) or an inline
// `canManageEvent`. GETs use `optionalAuth` so anonymous players resolve
// `canManage=false` rather than 401.
const {
  Event, EventMember, Activity, Participant, Question, EventViewer, User, Account,
} = require('../models');
const { ActivityStatus } = require('../constants/enums');
const { idStr, userDto, accountSummaryDto, activityDto } = require('../services/serializers');
const { RuleViolation, asyncHandler } = require('../middleware/error');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { canManageEvent, canManageEventAsAccount, eventManager } = require('../middleware/eventAuth');
const { eventChanged } = require('../socket/emit');
const env = require('../config/env');
const emailService = require('../services/email');
const { uniqueJoinCode, randomCode } = require('../utils/joinCode');
const { timingSafeEqualStr } = require('../utils/security');
const { buildStandings } = require('../services/standings');
const teams = require('../services/teams');
const { computePendingSlap } = require('../services/slap');
const { pushScoreboard } = require('../services/scoreboard');
const geo = require('../services/geo');

const router = express.Router();

const clean = (v) => {
  const s = (v ?? '').toString().trim();
  return s.length ? s : null;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ── EventDto builder ──────────────────────────────────────────────────────────
// Faithful port of LoadEventDtoAsync: combined ActivityDto list (ordered by
// order, then _id) with per-activity counts and team-based flags; the roster
// (members ordered by user name) + adminUserIds; the estimated route metres; and
// the recently-seen viewer names. `canManage`/`pendingSlap` are layered on by the
// callers that have the request / slaps.
async function loadEventDto(event) {
  const teamBased = event.teamSize > 1;

  // Wave 1 — independent reads run together: the activity list, the roster (also
  // gives us hasRosterCount, dropping a separate countDocuments), the live viewer
  // names, and the owner/co-admin accounts for the host UI.
  const [activities, memberRows, viewers, ownerAccount, coAdminAccounts] = await Promise.all([
    Activity.find({ eventId: event._id }).sort({ order: 1, _id: 1 }).lean(),
    EventMember.find({ eventId: event._id }).populate('userId', 'name').lean(),
    currentViewerNames(event._id),
    event.owner
      ? Account.findById(event.owner).select('username displayName email').lean()
      : null,
    (event.admins || []).length
      ? Account.find({ _id: { $in: event.admins } }).select('username displayName email').lean()
      : [],
  ]);

  // hasRosterCount = every member row (same as the old countDocuments — find
  // returns exactly the rows it would have counted).
  const hasRosterCount = memberRows.length;

  // Wave 2 — per-activity participant/question counts batched into two grouped
  // aggregations (was 2 countDocuments PER activity → 2 queries total), run
  // alongside the route-length estimate (its own one Question.find).
  const activityIds = activities.map((a) => a._id);
  const [partGroups, qGroups, estimatedMeters] = await Promise.all([
    activityIds.length
      ? Participant.aggregate([
          { $match: { activityId: { $in: activityIds } } },
          { $group: { _id: '$activityId', c: { $sum: 1 } } },
        ])
      : [],
    activityIds.length
      ? Question.aggregate([
          { $match: { activityId: { $in: activityIds } } },
          { $group: { _id: '$activityId', c: { $sum: 1 } } },
        ])
      : [],
    estimateRouteMeters(event._id, activities),
  ]);
  const partCounts = new Map(partGroups.map((g) => [String(g._id), g.c]));
  const qCounts = new Map(qGroups.map((g) => [String(g._id), g.c]));

  const activityDtos = activities.map((a) => {
    const participantCount = partCounts.get(String(a._id)) || 0;
    const questionCount = qCounts.get(String(a._id)) || 0;
    // For event activities: isTeamBased follows the event's team size; when a
    // roster exists, player/team counts come from the roster (matches the .NET
    // ActivityDto.LoadDto override) rather than the joined participant count.
    const isTeamBased = teamBased;
    const playerCount = hasRosterCount > 0 ? hasRosterCount : participantCount;
    const teamCount =
      hasRosterCount > 0 && isTeamBased ? Math.ceil(hasRosterCount / event.teamSize) : 0;
    return activityDto(a, {
      canManage: false,
      isTeamBased,
      participantCount,
      questionCount,
      playerCount,
      teamCount,
    });
  });

  // Roster members ordered by user name; adminUserIds = members flagged isAdmin.
  const sortedMembers = memberRows
    .filter((m) => m.userId)
    .sort((a, b) => (a.userId.name || '').localeCompare(b.userId.name || ''));
  const members = sortedMembers.map((m) => ({
    ...userDto(m.userId),
    // needsPin tells the claim UI to prompt for a PIN; an admin is always protected
    // even if a pin hasn't been backfilled yet (claim lazily generates one). The pin
    // VALUE is management-only — redactManagement strips it for non-managers.
    needsPin: m.isAdmin || !!m.claimPin,
    pin: m.claimPin || null,
  }));
  const adminUserIds = sortedMembers.filter((m) => m.isAdmin).map((m) => idStr(m.userId));

  return {
    id: idStr(event),
    ownerId: event.owner ? idStr(event.owner) : null,
    owner: accountSummaryDto(ownerAccount),
    coAdmins: coAdminAccounts.map(accountSummaryDto),
    name: event.name,
    description: event.description ?? null,
    imageUrl: event.imageUrl ?? null,
    teamSize: event.teamSize,
    scoring: event.scoring,
    teamShuffle: event.teamShuffle,
    slapMode: event.slapMode,
    pendingSlap: null,
    joinCode: event.joinCode,
    createdUtc: event.createdUtc,
    startsAt: event.startsAt ?? null,
    endsAt: event.endsAt ?? null,
    estimatedMeters,
    activities: activityDtos,
    members,
    adminUserIds,
    canManage: false,
    viewers,
    isArchived: event.isArchived ?? false,
    // Computed read-only props the client also reads.
    hasRoster: members.length > 0,
    isComplete:
      activityDtos.length > 0 && activityDtos.every((a) => a.status === ActivityStatus.Finished),
  };
}

// Owner/co-admin details (incl. email addresses) are management-only — strip them
// for callers who can't manage the event, so the anonymous player welcome list
// (GET /active) and the player event page never leak host emails. Call right
// after `dto.canManage` is set.
function redactManagement(dto) {
  if (!dto.canManage) {
    dto.owner = null;
    dto.coAdmins = [];
    // Claim PINs are a host secret (and feed the per-member QR) — keep needsPin so
    // the claim UI can prompt, but never expose the PIN value to non-managers.
    dto.members = (dto.members || []).map((m) => ({ ...m, pin: null }));
  }
  return dto;
}

// Walk the geolocated route in running order — each Tipspromenad's question
// stations (by order), else the activity's own geofence point — and sum the
// haversine legs. Null when fewer than two points (port of EstimateRouteMeters).
async function estimateRouteMeters(eventId, activities) {
  const activityIds = activities.map((a) => a._id);
  const stations = await Question.find({
    activityId: { $in: activityIds },
    latitude: { $ne: null },
    longitude: { $ne: null },
  })
    .select('activityId order latitude longitude')
    .lean();

  const points = [];
  for (const a of activities) {
    const qs = stations
      .filter((s) => String(s.activityId) === String(a._id))
      .sort((x, y) => x.order - y.order);
    if (qs.length > 0) {
      for (const s of qs) points.push([s.latitude, s.longitude]);
    } else if (a.latitude != null && a.longitude != null) {
      points.push([a.latitude, a.longitude]);
    }
  }

  if (points.length < 2) return null;
  let metres = 0;
  for (let i = 1; i < points.length; i += 1) {
    metres += geo.distanceMeters(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }
  return Math.round(metres);
}

// Recently-seen viewer names — distinct (case-insensitive), sorted, lastSeenUtc
// within the last 15 minutes.
async function currentViewerNames(eventId) {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  const rows = await EventViewer.find({ eventId, lastSeenUtc: { $gte: cutoff } })
    .select('name')
    .lean();
  const seen = new Map();
  for (const r of rows) {
    const key = (r.name || '').toLowerCase();
    if (!seen.has(key)) seen.set(key, r.name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// A fresh, non-zero partner-mixer seed (avoids repeating the current one).
function nextTeamSeed(current) {
  let seed;
  do {
    seed = Math.floor(Math.random() * 999999) + 1;
  } while (seed === current);
  return seed;
}

// Newest-first list of matching events: by startsAt ?? createdUtc desc, then _id
// desc (port of ListAllEventDtos; _id ≈ creation order). Returns { event, dto }
// pairs so callers can layer canManage from the already-loaded event doc rather
// than re-fetching it. DTOs are built concurrently.
async function listEventDtos(filter = {}) {
  const events = await Event.find(filter).lean();
  events.sort((a, b) => {
    const ak = a.startsAt || (a.createdUtc ? new Date(a.createdUtc).toISOString() : '');
    const bk = b.startsAt || (b.createdUtc ? new Date(b.createdUtc).toISOString() : '');
    if (ak !== bk) return ak < bk ? 1 : -1;
    return String(a._id) < String(b._id) ? 1 : -1;
  });
  const dtos = await Promise.all(events.map((ev) => loadEventDto(ev)));
  return events.map((event, i) => ({ event, dto: dtos[i] }));
}

// Events the account *manages* — owns or co-admins. (The super-admin role is for
// user/role administration, not event oversight, so it gets no blanket access.)
function managedEventFilter(req) {
  return { $or: [{ owner: req.user.id }, { admins: req.user.id }] };
}

// Events the account is *connected to* — manages, or is a roster member of (e.g.
// invited/added). Returns a Mongo filter, or null for "nothing" (anonymous).
async function connectedEventFilter(req) {
  const uid = req.user?.id;
  if (!uid) return null; // anonymous → no events (reach one via its code/link)
  const ors = [{ owner: uid }, { admins: uid }];
  const acct = await Account.findById(uid).select('userId').lean();
  if (acct?.userId) {
    const memberEventIds = await EventMember.find({ userId: acct.userId }).distinct('eventId');
    if (memberEventIds.length) ors.push({ _id: { $in: memberEventIds } });
  }
  return { $or: ors };
}

// ── Admin: create / list ──────────────────────────────────────────────────────

// POST /api/events — create an event. Auth: logged-in host; sets owner = the
// creating account so they manage it (hybrid-auth, replaces the shared code).
router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const {
      name, description, imageUrl, teamSize, scoring, teamShuffle, slapMode, startsAt, endsAt,
    } = req.body || {};
    if (!clean(name)) throw new RuleViolation('Give the event a name.');
    if (startsAt && endsAt && endsAt <= startsAt) {
      throw new RuleViolation("The event's end time must be after its start.");
    }

    // Honor the optional config at creation too (was previously dropped, forcing a
    // second PUT). Invalid enum values are rejected by the schema on save.
    const fields = {
      name: name.trim(),
      description: clean(description),
      imageUrl: clean(imageUrl),
      teamSize: clamp(teamSize ?? 2, 1, 20),
      startsAt: startsAt ?? null,
      endsAt: endsAt ?? null,
      joinCode: await uniqueJoinCode([Activity, Event]),
      createdUtc: new Date(),
      owner: req.user.id,
    };
    if (scoring != null) fields.scoring = scoring;
    if (teamShuffle != null) fields.teamShuffle = teamShuffle;
    if (slapMode != null) fields.slapMode = slapMode;
    // FixedForEvent needs a seed to lock teams; assign one when chosen up front.
    if (teamShuffle === 1 /* FixedForEvent */) fields.fixedTeamSeed = nextTeamSeed(0);

    const event = await Event.create(fields);

    const dto = await loadEventDto(event);
    dto.canManage = true; // the creator is the owner
    res.status(201).location(`/api/events/${event._id}`).json(dto);
  })
);

// GET /api/events — the host dashboard: only events you own or co-admin (a
// super-admin sees all). Auth: logged-in host.
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await listEventDtos(managedEventFilter(req));
    await Promise.all(rows.map(async ({ event, dto }) => {
      // Use the already-loaded event doc (no re-fetch); canManageEvent only needs
      // its owner/admins, which the lean doc carries.
      dto.canManage = await canManageEvent(req, event);
      redactManagement(dto);
    }));
    res.json(rows.map((r) => r.dto));
  })
);

// GET /api/events/active — player welcome page: only events you're connected to
// (manage or are a member of); logged-out callers get nothing and reach a
// specific event via its code/link. Excludes archived.
router.get(
  '/active',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const filter = await connectedEventFilter(req);
    if (!filter) return res.json([]); // anonymous → no events
    const rows = (await listEventDtos(filter)).filter(({ dto }) => !dto.isArchived);
    await Promise.all(rows.map(async ({ event, dto }) => {
      // Reuse the loaded event doc instead of re-fetching it per row.
      dto.canManage = await canManageEvent(req, event);
      redactManagement(dto);
    }));
    return res.json(rows.map((r) => r.dto));
  })
);

// ── Player GPS arrival (geo auto-start) ───────────────────────────────────────

// POST /api/events/:id/arrive — auto-start any OPEN activity whose own geofence,
// or (for Tipspromenad) any of its question geofences, the player has walked into.
// Distance = haversine; radius = the point's radiusMeters when > 0 else 25 m.
router.post(
  '/:id/arrive',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { lat, lng } = req.body || {};
    const open = await Activity.find({ eventId: req.params.id, status: ActivityStatus.Open });
    if (open.length === 0) return res.json({ started: [] });

    const tipsIds = open
      .filter((a) => a.type === 2 /* Tipspromenad */)
      .map((a) => a._id);
    const stations = tipsIds.length
      ? await Question.find({
          activityId: { $in: tipsIds },
          latitude: { $ne: null },
          longitude: { $ne: null },
        })
          .select('activityId latitude longitude radiusMeters')
          .lean()
      : [];

    const within = (la, ln, tLat, tLng, radius) =>
      geo.withinRadius(la, ln, tLat, tLng, radius > 0 ? radius : 25);

    const started = [];
    const startedDocs = [];
    for (const a of open) {
      const hereByActivity =
        a.latitude != null && a.longitude != null && within(lat, lng, a.latitude, a.longitude, a.radiusMeters || 0);
      const hereByStation = stations.some(
        (s) => String(s.activityId) === String(a._id) && within(lat, lng, s.latitude, s.longitude, s.radiusMeters || 0)
      );
      if (hereByActivity || hereByStation) {
        a.status = ActivityStatus.Live;
        if (!a.startedUtc) a.startedUtc = new Date();
        // eslint-disable-next-line no-await-in-loop
        await a.save();
        started.push(idStr(a));
        startedDocs.push(a);
      }
    }

    if (startedDocs.length > 0) {
      const { activityStatusChanged } = require('../socket/emit');
      const { notify } = require('../services/push');
      const event = await Event.findById(req.params.id);
      const evId = idStr(req.params.id);
      for (const a of startedDocs) {
        // Generate teams (roster events) so players can claim a session, then push.
        // eslint-disable-next-line no-await-in-loop
        if (event) await teams.ensureTeams(event, a);
        // eslint-disable-next-line no-await-in-loop
        await pushScoreboard(a._id);
        activityStatusChanged(idStr(a), { activityId: idStr(a), status: ActivityStatus.Live });
        // Web Push the whole event: someone reached the geofence and it's live now.
        notify(
          evId, '📍 First arrival!',
          `Someone reached “${a.title}” — it's live now.`,
          `e/${evId}`, `live-${idStr(a)}`,
        );
      }
    }

    return res.json({ started });
  })
);

// ── Event update / delete / code / members / teams ────────────────────────────

// DELETE /api/events/:id — remove an event. Auth: host who can manage it. Cascade
// (no Mongo FK) via deleteEventCascade; uploaded files are best-effort cleaned by
// the storage layer elsewhere.
router.delete(
  '/:id',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    const { deleteEventCascade } = require('../services/cascade');
    await deleteEventCascade(req.targetEvent._id);
    res.status(204).end();
  })
);

// PUT /api/events/:id — update event details. Auth: event-host. Validates name +
// the start/end window; clamps team size; mints a fixed-team seed on first switch
// to FixedForEvent; re-forms unplayed teams when the shuffle mode changed.
router.put(
  '/:id',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    const event = req.targetEvent;
    const body = req.body || {};
    if (!clean(body.name)) throw new RuleViolation('Give the event a name.');
    if (body.startsAt && body.endsAt && body.endsAt <= body.startsAt) {
      throw new RuleViolation("The event's end time must be after its start.");
    }

    const teamModeChanged = body.teamShuffle != null && event.teamShuffle !== body.teamShuffle;

    event.name = body.name.trim();
    event.description = clean(body.description);
    event.imageUrl = clean(body.imageUrl);
    event.teamSize = clamp(body.teamSize ?? 2, 1, 20);
    if (body.scoring != null) event.scoring = body.scoring;
    if (body.teamShuffle != null) event.teamShuffle = body.teamShuffle;
    // Fixed mode needs a seed to lock teams; assign one the first time it's chosen.
    if (event.teamShuffle === 1 /* FixedForEvent */ && event.fixedTeamSeed === 0) {
      event.fixedTeamSeed = nextTeamSeed(0);
    }
    if (body.slapMode != null) event.slapMode = body.slapMode;
    if (body.isArchived != null) event.isArchived = !!body.isArchived;
    event.startsAt = body.startsAt ?? null;
    event.endsAt = body.endsAt ?? null;
    await event.save();

    if (teamModeChanged) await teams.resetUnplayedTeams(event._id);

    const dto = await loadEventDto(event);
    dto.canManage = true;
    res.json(dto);
  })
);

// POST /api/events/:id/teams/reshuffle — host re-rolls the locked teams: force
// FixedForEvent, mint a fresh seed, regenerate unplayed teams; return the preview.
router.post(
  '/:id/teams/reshuffle',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    const event = req.targetEvent;
    event.teamShuffle = 1; // FixedForEvent
    event.fixedTeamSeed = nextTeamSeed(event.fixedTeamSeed);
    await event.save();

    await teams.resetUnplayedTeams(event._id);
    res.json(await teams.previewTeams(event));
  })
);

// GET /api/events/:id/teams — the team line-up the roster currently forms (host
// view; the locked set in fixed mode). Auth: event-host.
router.get(
  '/:id/teams',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    res.json(await teams.previewTeams(req.targetEvent));
  })
);

// PUT /api/events/:id/members — set the roster users + event admins. Auth:
// event-host (the original required the stricter site-admin code; the port keeps
// it to a manager since there is no shared code). Mints an EventMember token per
// new member, sets isAdmin on the kept/added set, removes dropped members.
// Side effect: eventChanged(eventId) so a just-(de)admined player's host controls
// update live.
router.put(
  '/:id/members',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    const event = req.targetEvent;
    const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    const adminUserIds = Array.isArray(req.body?.adminUserIds) ? req.body.adminUserIds : [];

    // `wanted` = the subset of userIds that are real users.
    const realUsers = await User.find({ _id: { $in: userIds } }).select('_id').lean();
    const wanted = new Set(realUsers.map((u) => idStr(u)));
    const admins = new Set(adminUserIds.map((id) => String(id)));

    // Last-admin guard: an event with no account owner and no account co-admins is
    // managed solely through its roster member-admins. Refuse a change that would
    // strip the final admin and leave it manageable only by a global super-admin.
    const hasAccountBackstop = !!event.owner || (event.admins || []).length > 0;
    const resultingMemberAdmins = [...wanted].filter((uid) => admins.has(uid)).length;
    if (!hasAccountBackstop && resultingMemberAdmins === 0) {
      throw new RuleViolation(
        'You must keep at least one admin (or set an event owner) — assign an admin before removing the last one.'
      );
    }

    const current = await EventMember.find({ eventId: event._id });
    const currentIds = new Set(current.map((m) => idStr(m.userId)));

    // Remove members no longer wanted.
    for (const m of current) {
      if (!wanted.has(idStr(m.userId))) {
        // eslint-disable-next-line no-await-in-loop
        await EventMember.deleteOne({ _id: m._id });
      }
    }
    // Update the admin flag on kept members. An admin is always PIN-protected, so
    // backfill a PIN when promoting (or for any admin still missing one).
    for (const m of current) {
      if (wanted.has(idStr(m.userId))) {
        m.isAdmin = admins.has(idStr(m.userId));
        if (m.isAdmin && !m.claimPin) m.claimPin = randomCode(6);
        // eslint-disable-next-line no-await-in-loop
        await m.save();
      }
    }
    // Add new members with a fresh token; new admins get a claim PIN.
    for (const uid of wanted) {
      if (!currentIds.has(uid)) {
        const isAdmin = admins.has(uid);
        // eslint-disable-next-line no-await-in-loop
        await EventMember.create({
          eventId: event._id,
          userId: uid,
          isAdmin,
          claimPin: isAdmin ? randomCode(6) : null,
          addedUtc: new Date(),
        });
      }
    }

    eventChanged(idStr(event));

    const dto = await loadEventDto(event);
    dto.canManage = true;
    res.json(dto);
  })
);

// PUT /api/events/:id/members/:userId/pin — set / clear / generate a roster member's
// claim PIN (manager only). Body { pin? (set explicit), generate? (random) };
// neither clears it — except an admin can never be left unprotected (clearing it
// regenerates). Returns { userId, needsPin, pin }.
router.put(
  '/:id/members/:userId/pin',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    const event = req.targetEvent;
    const member = await EventMember.findOne({ eventId: event._id, userId: req.params.userId });
    if (!member) throw new RuleViolation("That player isn't on this event's roster.", 404);

    const body = req.body || {};
    if (body.generate) {
      member.claimPin = randomCode(6);
    } else if (typeof body.pin === 'string' && body.pin.trim()) {
      member.claimPin = body.pin.trim().slice(0, 16);
    } else {
      member.claimPin = member.isAdmin ? randomCode(6) : null; // admins stay protected
    }
    await member.save();
    eventChanged(idStr(event));
    res.json({ userId: idStr(member.userId), needsPin: !!member.claimPin, pin: member.claimPin });
  })
);

// POST /api/events/:id/members/:userId/revoke — regenerate a member's device token
// (x-rundan-member), signing out their current device (they must re-claim/re-scan).
// Lets a host evict a lost/shared/leaked device without removing the roster entry.
// Manager-gated. 204.
router.post(
  '/:id/members/:userId/revoke',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    const event = req.targetEvent;
    const member = await EventMember.findOne({ eventId: event._id, userId: req.params.userId });
    if (!member) throw new RuleViolation("That player isn't on this event's roster.", 404);
    member.token = crypto.randomUUID();
    // Also ensure a claim PIN — otherwise the rotated-out device would just
    // silently re-claim (PIN-less) on its next load and re-authenticate itself,
    // defeating the revoke. With a PIN, re-entry requires the host's PIN/QR.
    if (!member.claimPin) member.claimPin = randomCode(6);
    await member.save();
    eventChanged(idStr(event));
    res.json({ ok: true, pin: member.claimPin });
  })
);

// ── Account co-admins (event.admins) ──────────────────────────────────────────
// Distinct from the roster EventMember admins above: these are full Accounts
// promoted to co-host an event, so the event is shared and any of them can manage
// it after logging in (canManageEvent honours event.admins). Any current manager
// may add/remove co-admins; the owner can never be removed.
const ADMIN_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function sendCoAdminEmail(account, event) {
  if (!emailService.isEnabled() || !account.email) return false;
  try {
    const base = (env.frontendUrl || '').split(',')[0].trim().replace(/\/$/, '');
    const url = base ? `${base}/e/${idStr(event)}` : null;
    await emailService.send({
      to: account.email,
      subject: `You're now a co-host of ${event.name} — ${env.appName}`,
      html: emailService.wrapTemplate({
        title: `You're a co-host of ${event.name}`,
        intro: 'You have been given admin access to this event. Log in to manage its games.',
        ctaUrl: url || undefined,
        ctaLabel: 'Open the event',
      }),
      text: `You're now a co-host of ${event.name}.${url ? ` ${url}` : ''}`,
    });
    return true;
  } catch (e) {
    console.error('Co-admin mail failed:', e.message);
    return false;
  }
}

// POST /api/events/:id/admins — body { email }. Promote an existing account
// (matched by email) to event co-admin. 404 if no such account (they must
// register first). Idempotent; best-effort notification email.
router.post(
  '/:id/admins',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    const event = req.targetEvent;
    // Managing the co-admin list requires being an account owner/admin (or
    // super-admin) — a delegated member token is not enough to grant durable rights.
    if (!canManageEventAsAccount(req, event)) {
      throw new RuleViolation('Only the event owner or an account admin can manage co-admins.', 403);
    }
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
    if (!ADMIN_EMAIL_RE.test(email)) throw new RuleViolation('Enter a valid email address.');

    const account = await Account.findOne({ email });
    if (!account) {
      throw new RuleViolation('No account with that email. Ask them to create an account first.', 404);
    }
    if (event.owner && String(event.owner) === String(account._id)) {
      throw new RuleViolation('That person already owns the event.');
    }

    const already = (event.admins || []).some((a) => String(a) === String(account._id));
    if (!already) {
      event.admins.push(account._id);
      await event.save();
      await sendCoAdminEmail(account, event);
      eventChanged(idStr(event));
    }

    const dto = await loadEventDto(event);
    dto.canManage = true;
    res.json(dto);
  })
);

// DELETE /api/events/:id/admins/:accountId — demote a co-admin. The owner can
// never be removed. Any manager may remove (including themselves).
router.delete(
  '/:id/admins/:accountId',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    const event = req.targetEvent;
    if (!canManageEventAsAccount(req, event)) {
      throw new RuleViolation('Only the event owner or an account admin can manage co-admins.', 403);
    }
    const { accountId } = req.params;
    if (event.owner && String(event.owner) === String(accountId)) {
      throw new RuleViolation('The owner cannot be removed.');
    }

    const before = (event.admins || []).length;
    event.admins = (event.admins || []).filter((a) => String(a) !== String(accountId));
    if (event.admins.length !== before) {
      await event.save();
      eventChanged(idStr(event));
    }

    const dto = await loadEventDto(event);
    dto.canManage = await canManageEvent(req, event);
    res.json(dto);
  })
);

// PUT /api/events/:id/code — set a custom join code or regenerate. Auth:
// event-host. Blank → regenerate unique; else upper/trim, 3–16 of letters/digits/
// dash, unique across other events AND all activities. Side effect: eventChanged.
router.put(
  '/:id/code',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    const event = req.targetEvent;
    const code = (req.body?.code ?? '').toString().trim().toUpperCase();

    if (code.length === 0) {
      event.joinCode = await uniqueJoinCode([Activity, Event]);
    } else {
      if (code.length < 3 || code.length > 16 || !/^[A-Z0-9-]+$/.test(code)) {
        throw new RuleViolation('A code must be 3–16 letters, numbers or dashes.');
      }
      const takenByEvent = await Event.exists({ joinCode: code, _id: { $ne: event._id } });
      const takenByActivity = await Activity.exists({ joinCode: code });
      if (takenByEvent || takenByActivity) {
        throw new RuleViolation('That code is already in use.', 409);
      }
      event.joinCode = code;
    }

    await event.save();
    eventChanged(idStr(event));

    const dto = await loadEventDto(event);
    dto.canManage = true;
    res.json(dto);
  })
);

// ── Activity ordering & bulk status (event-host) ──────────────────────────────

// PUT /api/events/:id/reorder — set running order. Auth: event-host. For each id
// in the array that belongs to the event, set order = 1,2,3,… in array order.
router.put(
  '/:id/reorder',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.activityIds) ? req.body.activityIds : [];
    const activities = await Activity.find({ eventId: req.targetEvent._id });
    let order = 1;
    for (const activityId of ids) {
      const match = activities.find((a) => String(a._id) === String(activityId));
      if (match) {
        match.order = order;
        order += 1;
        // eslint-disable-next-line no-await-in-loop
        await match.save();
      }
    }
    res.status(204).end();
  })
);

// PUT /api/events/:id/activities/status — bulk reset every activity to Draft or
// Open (only those two allowed), without touching scores. Auth: event-host.
// Clears finishedUtc; Draft also clears startedUtc. Opening forms teams. Emits a
// status change per changed activity.
router.put(
  '/:id/activities/status',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    const status = req.body?.status;
    if (status !== ActivityStatus.Draft && status !== ActivityStatus.Open) {
      throw new RuleViolation('Resetting all activities only supports Draft or Open.');
    }

    const event = req.targetEvent;
    const activities = await Activity.find({ eventId: event._id });
    const changed = [];
    for (const a of activities) {
      if (a.status !== status) {
        a.status = status;
        a.finishedUtc = null;
        if (status === ActivityStatus.Draft) a.startedUtc = null;
        // eslint-disable-next-line no-await-in-loop
        await a.save();
        changed.push(a);
      }
    }

    if (changed.length > 0) {
      const { activityStatusChanged } = require('../socket/emit');
      if (status === ActivityStatus.Open) {
        for (const a of changed) {
          // eslint-disable-next-line no-await-in-loop
          await teams.ensureTeams(event, a);
        }
      }
      for (const a of changed) {
        activityStatusChanged(idStr(a), { activityId: idStr(a), status });
      }
    }

    res.status(204).end();
  })
);

// ── Event-wide simulate / reset (event-host) ──────────────────────────────────

// POST /api/events/:id/activities/from-library/:sourceId — deep-copy a PUBLIC
// library activity (config + questions + options + courts + memory cards) into
// this event as a fresh Draft. Auth: event-host. Returns the new ActivityDto.
router.post(
  '/:id/activities/from-library/:sourceId',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    // eslint-disable-next-line global-require
    const activityLibrary = require('../services/activityLibrary');
    const ev = req.targetEvent;
    const { activity, questionCount } = await activityLibrary.copyToEvent(
      req.params.sourceId, ev._id, req.user?.id || null,
    );
    const plain = activity.toObject();
    plain.courts = (activity.courts || []).slice().sort((a, b) => a.order - b.order);
    // Derive roster counts like loadActivityDto / the .NET LoadDtoAsync so the
    // returned DTO matches a subsequent reload (no participants yet → 0).
    const memberCount = await EventMember.countDocuments({ eventId: ev._id });
    res.status(201).json(activityDto(plain, {
      canManage: true,
      participantCount: 0,
      questionCount,
      isTeamBased: ev.teamSize > 1,
      playerCount: memberCount,
      teamCount: memberCount > 0 && ev.teamSize > 1 ? Math.ceil(memberCount / ev.teamSize) : 0,
    }));
  })
);

// POST /api/events/:id/simulate — dry-run fill every activity (in running order)
// with plausible random results so the host can preview the whole event before the
// real day. Expected "nothing to simulate" cases (RuleViolation, e.g. no
// participants) are counted as skipped; any OTHER error is logged and reported in
// `failures` rather than silently swallowed (which once hid a real 500 bug).
// Returns { simulated, skipped, failed, failures }.
router.post(
  '/:id/simulate',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    // eslint-disable-next-line global-require
    const simulation = require('../services/simulation');
    const event = req.targetEvent;
    const activities = await Activity.find({ eventId: event._id }).sort({ order: 1, _id: 1 });

    const { activityStatusChanged } = require('../socket/emit');
    const { pushScoreboard: push } = require('../services/scoreboard');

    let simulated = 0;
    let skipped = 0;
    const failures = [];
    for (const a of activities) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await simulation.simulate(a);
        simulated += 1; // the activity is now simulated + persisted (Finished)
      } catch (e) {
        if (e instanceof RuleViolation) {
          skipped += 1; // legitimately unsimulatable (e.g. no participants/questions)
        } else {
          failures.push({ activityId: idStr(a), title: a.title, error: e.message });
          console.error(`Event simulate failed for activity ${idStr(a)}:`, e.message);
        }
        // eslint-disable-next-line no-continue
        continue;
      }
      // Side-effects are isolated so a transient push/scoreboard error doesn't
      // mis-report an already-simulated activity as a failure.
      try {
        activityStatusChanged(idStr(a), { activityId: idStr(a), status: a.status });
        // eslint-disable-next-line no-await-in-loop
        await push(a._id);
      } catch (e) {
        console.error(`Event simulate push failed for activity ${idStr(a)}:`, e.message);
      }
    }

    res.json({ simulated, skipped, failed: failures.length, failures });
  })
);

// POST /api/events/:id/reset-results — clear every activity's derived state and
// return each to Draft (run stamps cleared), pushing the (now empty) scoreboard
// per activity. When ?clearChat=true, also wipes the event chat. Mirrors the
// per-activity reset the host can run, applied across the whole event. Returns
// { reset: <count> }.
router.post(
  '/:id/reset-results',
  requireAuth,
  eventManager,
  asyncHandler(async (req, res) => {
    // eslint-disable-next-line global-require
    const simulation = require('../services/simulation');
    // eslint-disable-next-line global-require
    const { pushScoreboard: push } = require('../services/scoreboard');
    const { activityStatusChanged } = require('../socket/emit');
    const { ChatMessage, Participant } = require('../models');
    const event = req.targetEvent;
    const activities = await Activity.find({ eventId: event._id }).sort({ order: 1, _id: 1 });

    let reset = 0;
    for (const a of activities) {
      // eslint-disable-next-line no-await-in-loop
      await simulation.clearResults(a);
      // Drop generated teams so a re-open re-forms them from the CURRENT roster
      // (ensureTeams is idempotent, so stale teams would otherwise persist).
      // eslint-disable-next-line no-await-in-loop
      await Participant.deleteMany({ activityId: a._id, isTeam: true });
      a.status = ActivityStatus.Draft;
      a.startedUtc = null;
      a.finishedUtc = null;
      // eslint-disable-next-line no-await-in-loop
      await a.save();
      // eslint-disable-next-line no-await-in-loop
      await push(a._id);
      // Tell live clients the activity went back to Draft (was missing before).
      activityStatusChanged(idStr(a), { activityId: idStr(a), status: ActivityStatus.Draft });
      reset += 1;
    }

    if (req.query.clearChat === 'true') {
      await ChatMessage.deleteMany({ eventId: event._id });
    }

    res.json({ reset });
  })
);

// ── Players: look up + standings ──────────────────────────────────────────────

// GET /api/events/:id — load an event by id (access-gated). Adds pendingSlap and
// per-request canManage (anonymous players get false via optionalAuth).
router.get(
  '/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found.' });

    const dto = await loadEventDto(event);
    dto.pendingSlap = await computePendingSlap(event);
    dto.canManage = await canManageEvent(req, event);
    redactManagement(dto);
    return res.json(dto);
  })
);

// GET /api/events/by-code/:code — look up an event by its join code (normalized
// upper/trim). Same DTO as GET /:id (pendingSlap + canManage).
router.get(
  '/by-code/:code',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const normalized = req.params.code.trim().toUpperCase();
    const event = await Event.findOne({ joinCode: normalized });
    if (!event) return res.status(404).json({ error: 'Event not found.' });

    const dto = await loadEventDto(event);
    dto.pendingSlap = await computePendingSlap(event);
    dto.canManage = await canManageEvent(req, event);
    redactManagement(dto);
    return res.json(dto);
  })
);

// GET /api/events/:id/standings — combined standings across all activities.
// Access-gated. 404 when the event is missing (buildStandings returns null).
router.get(
  '/:id/standings',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const dto = await buildStandings(req.params.id);
    if (!dto) return res.status(404).json({ error: 'Event not found.' });
    return res.json(dto);
  })
);

// ── Players: join the whole event with one name (free-name, additive) ─────────

// POST /api/events/by-code/:code/join — create participants in every joinable
// activity (Open/Live) the name isn't already in; idempotent/additive (re-call to
// pick up newly opened activities). Returns only the newly created slots. Emits
// participantJoined + pushScoreboard per created participant.
router.post(
  '/by-code/:code/join',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const normalized = req.params.code.trim().toUpperCase();
    const event = await Event.findOne({ joinCode: normalized });
    if (!event) throw new RuleViolation('No event with that code.', 404);

    let name = (req.body?.displayName ?? '').toString().trim();
    if (name.length === 0) throw new RuleViolation('Enter a name to join with.');
    if (name.length > 60) name = name.slice(0, 60);

    // A person already on the roster must claim their identity ("Play as me"),
    // not free-name join — otherwise they'd be double-listed (team row + solo row).
    const rosterMembers = await EventMember.find({ eventId: event._id })
      .populate('userId', 'name')
      .lean();
    const onRoster = rosterMembers.some(
      (m) => m.userId && (m.userId.name || '').toLowerCase() === name.toLowerCase()
    );
    if (onRoster) {
      throw new RuleViolation(
        'You are on the roster for this event — open it and choose "Play as me" to join.',
        409
      );
    }

    const joinable = (
      await Activity.find({
        eventId: event._id,
        status: { $in: [ActivityStatus.Open, ActivityStatus.Live] },
      })
    ).sort((a, b) => a.order - b.order);

    const created = [];
    for (const act of joinable) {
      // eslint-disable-next-line no-await-in-loop
      const taken = await Participant.exists({ activityId: act._id, displayName: name });
      if (taken) continue; // already in this activity (re-join, or name reused)

      let participant;
      try {
        // eslint-disable-next-line no-await-in-loop
        participant = await Participant.create({
          activityId: act._id,
          displayName: name,
          joinedUtc: new Date(),
        });
      } catch (err) {
        if (err && err.code === 11000) {
          throw new RuleViolation('That name was just taken — pick another.', 409);
        }
        throw err;
      }
      created.push({ activityId: act._id, participant });
    }

    if (created.length > 0) {
      const { participantJoined } = require('../socket/emit');
      const { pushScoreboard } = require('../services/scoreboard');
      const { participantDto } = require('../services/serializers');
      for (const { activityId, participant } of created) {
        participantJoined(idStr(activityId), participantDto(participant));
        // eslint-disable-next-line no-await-in-loop
        await pushScoreboard(activityId);
      }
    }

    return res.json({
      eventId: idStr(event),
      displayName: name,
      slots: created.map((c) => ({
        activityId: idStr(c.activityId),
        participantId: idStr(c.participant),
        token: c.participant.token,
        teamName: '',
      })),
    });
  })
);

// ── Roster events: claim a pre-registered identity → team sessions ────────────

// POST /api/events/by-code/:code/claim — find the member for (event, userId),
// generate teams as needed for each joinable activity, and return the caller's
// team session per activity plus their member token. Idempotent. Emits
// pushScoreboard for each activity a slot was produced in.
router.post(
  '/by-code/:code/claim',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const normalized = req.params.code.trim().toUpperCase();
    const event = await Event.findOne({ joinCode: normalized });
    if (!event) throw new RuleViolation('No event with that code.', 404);

    // Coerce to a string so a crafted {userId:{$ne:null}} can't match an arbitrary
    // member and leak its (possibly admin) member token (NoSQL operator injection).
    let userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    // The caller's OWN linked roster identity (if logged in) — proven, so PIN-free.
    const ownUserId = req.user
      ? String((await Account.findById(req.user.id).select('userId').lean())?.userId || '')
      : '';
    // "Play as me": a logged-in account claims its own linked roster identity.
    if (!userId && ownUserId) userId = ownUserId;
    if (!userId) throw new RuleViolation('Pick a player to claim.');

    const member = await EventMember.findOne({ eventId: event._id, userId })
      .populate('userId', 'name');
    if (!member) throw new RuleViolation("That player isn't on this event's roster.", 404);

    // Admins are ALWAYS PIN-protected — lazily backfill a PIN for any admin missing
    // one (covers admins created before this feature on the live app) so an admin
    // identity (and its co-host token) can never be claimed PIN-free.
    if (member.isAdmin && !member.claimPin) {
      member.claimPin = randomCode(6);
      await member.save();
    }
    // Claiming your OWN logged-in identity needs no PIN; anyone else claiming a
    // protected member (admin, or a host-set PIN) must present the correct PIN.
    const isOwn = !!ownUserId && ownUserId === String(userId);
    if (member.claimPin && !isOwn) {
      const pin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';
      if (!timingSafeEqualStr(pin, member.claimPin)) {
        throw new RuleViolation(
          'Wrong or missing PIN for this player. Ask the host for the PIN, or scan their QR code.',
          403,
        );
      }
    }

    // Optional explicit "this is me" link: a logged-in account with no roster
    // identity yet may adopt the claimed roster person (only if no other account
    // owns it). NEVER for an admin or PIN-protected member — otherwise a one-time
    // PIN would become a permanent PIN-free admin claim ("play as me" skips the PIN
    // for your own linked identity), defeating the P0 takeover protection. Those
    // identities are linked only via an explicit, host-mediated invite designation.
    if (req.body?.link === true && req.user && !ownUserId
        && !member.isAdmin && !member.claimPin) {
      const taken = await Account.exists({ userId, _id: { $ne: req.user.id } });
      if (!taken) await Account.updateOne({ _id: req.user.id }, { $set: { userId } });
    }

    const joinable = (
      await Activity.find({
        eventId: event._id,
        status: { $in: [ActivityStatus.Open, ActivityStatus.Live] },
      })
    ).sort((a, b) => a.order - b.order);

    const { pushScoreboard } = require('../services/scoreboard');
    const slots = [];
    for (const act of joinable) {
      // eslint-disable-next-line no-await-in-loop
      const generated = await teams.ensureTeams(event, act);
      const myTeam = generated.find((t) =>
        (t.members || []).some((m) => String(m.userId) === String(userId))
      );
      if (myTeam) {
        slots.push({
          activityId: idStr(act),
          participantId: idStr(myTeam),
          token: myTeam.token,
          teamName: myTeam.displayName,
        });
        // eslint-disable-next-line no-await-in-loop
        await pushScoreboard(act._id);
      }
    }

    return res.json({
      eventId: idStr(event),
      userId: idStr(member.userId),
      displayName: member.userId.name,
      memberToken: member.token,
      isEventAdmin: member.isAdmin,
      slots,
    });
  })
);

module.exports = router;
