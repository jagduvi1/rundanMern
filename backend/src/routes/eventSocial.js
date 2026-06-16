const express = require('express');

// EventEndpoints (social subset) — the MERN port of the chat / viewers / slap /
// push handlers of rundan's EventEndpoints.cs. Mounted under `/api/events` (see
// app.js); only this router's sub-paths are defined here. The create/list/get/
// members/teams/join/claim/standings parts live in routes/events.js.
//
// Auth model (hybrid port): GETs and player writes use `optionalAuth` so an
// anonymous player resolves rather than 401s. The slap actor is the caller's
// roster identity — `resolveMemberUserId(req, eventId)` maps their x-rundan-member
// token to a userId (a player in the event); a logged-in host who can manage the
// event is also allowed (faithful to the .NET 403 rules, plus the JWT host).
const {
  Event, Activity, EventViewer, ChatMessage, PushSubscription,
} = require('../models');
const { idStr, chatMessageDto, viewerDto } = require('../services/serializers');
const { RuleViolation, asyncHandler } = require('../middleware/error');
const { optionalAuth } = require('../middleware/auth');
const { canManageEvent, resolveMemberUserId } = require('../middleware/eventAuth');
const { chatPosted, viewersChanged, eventChanged } = require('../socket/emit');
const slap = require('../services/slap');
const push = require('../services/push');
const { pushScoreboard } = require('../services/scoreboard');

const router = express.Router();

// Recently-seen viewer names — distinct (case-insensitive), sorted, lastSeenUtc
// within the last 15 minutes (port of CurrentViewerNamesAsync).
const VIEWER_WINDOW_MS = 15 * 60 * 1000;
async function currentViewerNames(eventId) {
  const cutoff = new Date(Date.now() - VIEWER_WINDOW_MS);
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

// ── Group chat (per event) ─────────────────────────────────────────────────────

// GET /api/events/:id/chat — latest 200 messages, returned oldest-first (query
// newest 200 by _id desc, then reverse). Access-gated (any caller).
router.get(
  '/:id/chat',
  asyncHandler(async (req, res) => {
    const messages = await ChatMessage.find({ eventId: req.params.id })
      .sort({ _id: -1 })
      .limit(200)
      .lean();
    messages.reverse(); // oldest first for display
    res.json(messages.map(chatMessageDto));
  })
);

// POST /api/events/:id/chat — post a message. text trim, empty→400, truncate 1000;
// author trim, empty→"Someone", truncate 60. Event must exist (404). Persists a
// ChatMessage; emits ChatPosted(eventId, dto) + best-effort Web Push to the event.
router.post(
  '/:id/chat',
  asyncHandler(async (req, res) => {
    let text = (req.body?.text ?? '').toString().trim();
    if (text.length === 0) throw new RuleViolation('Type a message first.');
    if (text.length > 1000) text = text.slice(0, 1000);

    let author = (req.body?.author ?? '').toString().trim();
    author = author.length === 0 ? 'Someone' : author.length > 60 ? author.slice(0, 60) : author;

    if (!(await Event.exists({ _id: req.params.id }))) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    const msg = await ChatMessage.create({
      eventId: req.params.id,
      author,
      text,
      createdUtc: new Date(),
    });

    const dto = chatMessageDto(msg);
    const eventId = idStr(req.params.id);
    chatPosted(eventId, dto);
    push.notify(eventId, `💬 ${dto.author}`, dto.text, `e/${eventId}`, 'chat');
    return res.json(dto);
  })
);

// ── Viewers (spectators) ───────────────────────────────────────────────────────

// POST /api/events/:id/viewers — register / heartbeat. Event exists (404). name
// trim, empty→400, truncate 60. Reuse the viewer by token (for this event) when
// given, else mint a new one; set lastSeenUtc=now. Emits ViewersChanged. Returns
// ViewerDto. Clients re-POST with their token to stay "current".
router.post(
  '/:id/viewers',
  asyncHandler(async (req, res) => {
    if (!(await Event.exists({ _id: req.params.id }))) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    let name = (req.body?.name ?? '').toString().trim();
    if (name.length === 0) throw new RuleViolation('Enter a name to watch.');
    if (name.length > 60) name = name.slice(0, 60);

    const token = (req.body?.token ?? '').toString().trim() || null;
    let viewer = token
      ? await EventViewer.findOne({ token, eventId: req.params.id })
      : null;
    if (!viewer) {
      viewer = new EventViewer({ eventId: req.params.id });
    }
    viewer.name = name;
    viewer.lastSeenUtc = new Date();
    await viewer.save();

    const eventId = idStr(req.params.id);
    viewersChanged(eventId, { eventId, viewers: await currentViewerNames(req.params.id) });
    return res.json(viewerDto(viewer));
  })
);

// DELETE /api/events/:id/viewers/:token — remove the matching viewer (if any); if
// one was deleted, emit ViewersChanged. Always 204 (even if not found).
router.delete(
  '/:id/viewers/:token',
  asyncHandler(async (req, res) => {
    const deleted = await EventViewer.findOneAndDelete({
      token: req.params.token,
      eventId: req.params.id,
    });
    if (deleted) {
      const eventId = idStr(req.params.id);
      viewersChanged(eventId, { eventId, viewers: await currentViewerNames(req.params.id) });
    }
    res.status(204).end();
  })
);

// ── Web Push (notifications) ───────────────────────────────────────────────────

// GET /api/events/:id/push/key — the server VAPID public key (PushKeyDto). (In the
// original this lives at /api/push/key; under this router's /api/events base it is
// keyed by event for the client, but the key itself is global.)
router.get(
  '/:id/push/key',
  asyncHandler(async (req, res) => {
    res.json({ publicKey: push.vapidPublicKey() });
  })
);

// POST /api/events/:id/push/subscribe — upsert a browser push subscription by
// endpoint (one row per device). All three fields required (any blank → 400).
// Event must exist (404). 204.
router.post(
  '/:id/push/subscribe',
  asyncHandler(async (req, res) => {
    const endpoint = (req.body?.endpoint ?? '').toString().trim();
    const p256dh = (req.body?.p256dh ?? '').toString().trim();
    const auth = (req.body?.auth ?? '').toString().trim();
    if (!endpoint || !p256dh || !auth) {
      throw new RuleViolation('Invalid push subscription.');
    }
    if (!(await Event.exists({ _id: req.params.id }))) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    // Upsert by endpoint — re-point it at the event they just subscribed under.
    const existing = await PushSubscription.findOne({ endpoint });
    if (!existing) {
      await PushSubscription.create({
        eventId: req.params.id,
        endpoint,
        p256dh,
        auth,
        createdUtc: new Date(),
      });
    } else {
      existing.eventId = req.params.id;
      existing.p256dh = p256dh;
      existing.auth = auth;
      await existing.save();
    }

    return res.status(204).end();
  })
);

// ── Slaps (the optional twist) ─────────────────────────────────────────────────
//
// The slap surface. `getActivitySlap`/`performSlap`/`sendSlapPoints`/`skipSlap`
// live in services/slap.js. In rundan the read is GET /api/activities/{id}/slap;
// under this /api/events base it is exposed as GET /:id/slap where `:id` is the
// ACTIVITY id (the slap state is per finished activity, and the service resolves
// the owning event from it). The mutating routes match the .NET EventEndpoints
// shapes: perform = POST /:id/slap, send = POST /:id/slap/send-points, skip =
// POST /:id/slap/skip — there `:id` is the EVENT id and the activity is in the body.
//
// After any slap mutation: rebuild + push the activity scoreboard, and emit
// EventChanged(eventId) so every player's standings/host controls refresh.

// GET /api/events/:id/slap — the slap ceremony state for one finished activity
// (`:id` = activity id). Always 200 (state=None when no slap applies).
router.get(
  '/:id/slap',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const dto = await slap.getActivitySlap(null, req.params.id);
    res.json(dto);
  })
);

// Resolve the acting event + actor for a slap mutation. The slapper/sender must
// prove they are a player of this event (their x-rundan-member token → userId);
// a logged-in host who can manage the event is also allowed. 404 if no event;
// 403 if the caller is neither a member nor a manager.
async function slapActor(req, message) {
  const event = await Event.findById(req.params.id);
  if (!event) throw new RuleViolation('Event not found.', 404);

  const actorUserId = await resolveMemberUserId(req, event._id);
  if (actorUserId == null && !(await canManageEvent(req, event))) {
    throw new RuleViolation(message, 403);
  }
  return { event, actorUserId };
}

// After a slap change: nudge the activity scoreboard + tell the event to refresh.
async function afterSlap(activityId, eventId) {
  await pushScoreboard(activityId);
  eventChanged(eventId);
}

// POST /api/events/:id/slap — a winning player performs the slap on a rival
// (`:id` = event id; PerformSlapRequest{activityId, slappedUserId, recipientUserId?}
// in the body). Caller must be a player in this event (or a host).
router.post(
  '/:id/slap',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { event, actorUserId } = await slapActor(req, 'Only a player in this event can slap.');
    const { activityId, slappedUserId, recipientUserId } = req.body || {};

    await slap.performSlap(event, {
      activityId, slappedUserId, recipientUserId, actorUserId,
    });
    await afterSlap(activityId, idStr(event._id));
    res.json({ ok: true });
  })
);

// POST /api/events/:id/slap/send-points — SlappedSends mode: the slapped player
// passes their lost points on (SendSlapPointsRequest{activityId, recipientUserId}).
// Caller must be a player in this event (the recorded slapped player; or a host).
router.post(
  '/:id/slap/send-points',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { event, actorUserId } = await slapActor(req, 'Only a player in this event can do that.');
    const { activityId, recipientUserId } = req.body || {};

    await slap.sendSlapPoints(event, {
      activityId,
      recipientUserId,
      senderUserId: actorUserId != null ? actorUserId : undefined,
    });
    await afterSlap(activityId, idStr(event._id));
    res.json({ ok: true });
  })
);

// POST /api/events/:id/slap/skip — host skips the pending slap
// (SkipSlapRequest{activityId}). Event-host only (else 403).
router.post(
  '/:id/slap/skip',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const event = await Event.findById(req.params.id);
    if (!event) throw new RuleViolation('Event not found.', 404);
    if (!(await canManageEvent(req, event))) {
      return res.status(403).json({ error: 'Only the host or an event admin can do this.' });
    }

    const { activityId } = req.body || {};
    await slap.skipSlap(event, { activityId });
    await afterSlap(activityId, idStr(event._id));
    return res.json({ ok: true });
  })
);

module.exports = router;
