const express = require('express');

const { Account, Event } = require('../models');
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
  const hasAccount = !!(await Account.exists({ email: invite.email }));
  return res.json({
    email: invite.email,
    eventId: idStr(invite.eventId),
    eventName: event.name,
    invitedByName: inviter ? (inviter.displayName || inviter.username) : null,
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
  const eventId = await invites.acceptInvite(account, invite);
  eventChanged(idStr(eventId));
  return res.json({ eventId: idStr(eventId) });
}));

module.exports = router;
