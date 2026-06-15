const { Event, EventMember } = require('../models');
const env = require('../config/env');
const { asyncHandler } = require('./error');

// Event/activity management authorization — the MERN port of rundan's
// EventAuthorization. Hybrid model:
//   1. A global `admin`-role account is super-admin over everything.
//   2. The account that owns the event (or is in event.admins) manages it.
//   3. An account-less co-host may present an event-admin member token
//      (`x-rundan-member`) — preserves rundan's delegated event admins.
//   4. "Event has no admins ⇒ open unless the deployment is locked (prod)" so
//      nobody is locked out of an unconfigured/seeded event.
const MEMBER_HEADER = 'x-rundan-member';

const getMemberToken = (req) => {
  const t = (req.headers[MEMBER_HEADER] || '').toString().trim();
  return t || null;
};

async function matchesEventAdminToken(req, eventId) {
  const token = getMemberToken(req);
  if (!token) return false;
  return !!(await EventMember.exists({ token, eventId, isAdmin: true }));
}

async function canManageEvent(req, event) {
  if (req.user?.roles?.includes('admin')) return true; // (1)
  if (!event) return !!req.user || !env.isProd; // (2) creating: logged-in, or open in dev

  const uid = req.user?.id ? String(req.user.id) : null;
  if (uid && event.owner && String(event.owner) === uid) return true; // (3)
  if (uid && (event.admins || []).some((a) => String(a) === uid)) return true;
  if (await matchesEventAdminToken(req, event._id)) return true; // (4)

  const hasAdmins =
    !!event.owner ||
    (event.admins || []).length > 0 ||
    !!(await EventMember.exists({ eventId: event._id, isAdmin: true }));
  if (!hasAdmins) return !env.isProd; // (5)
  return false;
}

// Account-only management check (no member token) — for granting/revoking
// durable account co-admins: super-admin, the event owner, or an existing
// account co-admin. A delegated x-rundan-member token is deliberately NOT enough.
function canManageEventAsAccount(req, event) {
  if (req.user?.roles?.includes('admin')) return true;
  if (!event) return false;
  const uid = req.user?.id ? String(req.user.id) : null;
  if (!uid) return false;
  if (event.owner && String(event.owner) === uid) return true;
  return (event.admins || []).some((a) => String(a) === uid);
}

// Activity-scoped: resolve to its event and delegate. Standalone activities
// (no eventId) are governed by their own `owner` (the account that created them):
// super-admin or that owner may manage; activities with no recorded owner
// (legacy/seeded) fall back to the dev-open rule.
async function canManageActivity(req, activity) {
  if (!activity) return false;
  if (!activity.eventId) {
    if (req.user?.roles?.includes('admin')) return true;
    const uid = req.user?.id ? String(req.user.id) : null;
    if (activity.owner) return !!uid && String(activity.owner) === uid;
    return !!req.user || !env.isProd; // legacy/seeded: no owner recorded
  }
  const event = await Event.findById(activity.eventId);
  return canManageEvent(req, event);
}

// Image upload — any logged-in account or an event-admin member token; open in dev.
async function canUpload(req) {
  if (req.user?.roles?.includes('admin')) return true;
  if (req.user) return true;
  const token = getMemberToken(req);
  if (token && (await EventMember.exists({ token, isAdmin: true }))) return true;
  return !env.isProd;
}

// Resolve the roster userId a member token represents in an event (slap actor).
async function resolveMemberUserId(req, eventId) {
  const token = getMemberToken(req);
  if (!token) return null;
  const m = await EventMember.findOne({ token, eventId }).select('userId');
  return m ? m.userId : null;
}

// ── Ready-made route middlewares ──────────────────────────────────────────────

// Loads req.params.id as an EVENT, authorizes, attaches req.targetEvent.
const eventManager = asyncHandler(async (req, res, next) => {
  const event = await Event.findById(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  if (!(await canManageEvent(req, event))) {
    return res.status(403).json({ error: 'Only the host or an event admin can do this.' });
  }
  req.targetEvent = event;
  next();
});

// Loads req.params.id as an ACTIVITY, authorizes, attaches req.targetActivity.
const activityManager = asyncHandler(async (req, res, next) => {
  const { Activity } = require('../models');
  const activity = await Activity.findById(req.params.id);
  if (!activity) return res.status(404).json({ error: 'Activity not found.' });
  if (!(await canManageActivity(req, activity))) {
    return res.status(403).json({ error: 'Only the host or an event admin can do this.' });
  }
  req.targetActivity = activity;
  next();
});

module.exports = {
  canManageEvent,
  canManageEventAsAccount,
  canManageActivity,
  canUpload,
  resolveMemberUserId,
  getMemberToken,
  eventManager,
  activityManager,
};
