const express = require('express');

const { Account, Event, User } = require('../models');
const { asyncHandler } = require('../middleware/error');
const { requireAuth } = require('../middleware/auth');
const { idStr } = require('../services/serializers');
const { eventChanged } = require('../socket/emit');
const invites = require('../services/invites');

// Public invite landing (mounts at /api/invites). The accept page reads the
// context (who/what), then either registers a new account (handled by the
// register route, which carries the inviteToken) or logs in and POSTs accept.
const router = express.Router();

// GET /api/invites/:token — context for the accept page (no auth).
router.get('/:token', asyncHandler(async (req, res) => {
  const invite = await invites.findPendingInvite(req.params.token);
  if (!invite) return res.status(404).json({ error: 'This invite is invalid or has expired.' });
  const event = await Event.findById(invite.eventId).select('name');
  if (!event) return res.status(404).json({ error: 'The event no longer exists.' });
  const inviter = invite.invitedBy
    ? await Account.findById(invite.invitedBy).select('displayName username').lean()
    : null;
  const designated = invite.userId
    ? await User.findById(invite.userId).select('name').lean()
    : null;
  const hasAccount = !!(await Account.exists({ email: invite.email }));
  // Don't echo the address back to the INVITER (who may have invited a friend by
  // account id and shouldn't harvest their email via this public context route);
  // the actual invitee (a different session) still gets it to drive the accept UI.
  const isInviter = req.user && invite.invitedBy
    && String(req.user.id) === String(invite.invitedBy);
  return res.json({
    email: isInviter ? null : invite.email,
    eventId: idStr(invite.eventId),
    eventName: event.name,
    invitedByName: inviter ? (inviter.displayName || inviter.username) : null,
    // The roster person this invite is for (so the accept page can say "as Johan").
    designatedName: designated ? designated.name : null,
    // A non-designated invite carries no roster identity — the host may have
    // suggested a name; the accept page prefills it and lets the invitee edit it.
    suggestedName: designated ? null : (invite.name || null),
    hasAccount,
  });
}));

// POST /api/invites/:token/accept — a logged-in account whose email matches the
// invite joins the event. (New-account registrations join via the register route.)
router.post('/:token/accept', requireAuth, asyncHandler(async (req, res) => {
  const invite = await invites.findPendingInvite(req.params.token);
  if (!invite) return res.status(404).json({ error: 'This invite is invalid or has expired.' });
  const account = await Account.findById(req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  if (String(account.email).toLowerCase() !== String(invite.email).toLowerCase()) {
    return res.status(403).json({
      error: `This invite is for ${invite.email}. Log in with that email to accept it.`,
    });
  }
  // `name` lets an invitee not tied to an existing roster person choose the name
  // they'll appear as (ignored when the invite designates a roster identity or the
  // account is already linked to one).
  const name = typeof req.body?.name === 'string' ? req.body.name : null;
  const eventId = await invites.acceptInvite(account, invite, { name });
  eventChanged(idStr(eventId));
  return res.json({ eventId: idStr(eventId) });
}));

module.exports = router;
