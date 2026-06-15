const express = require('express');
const mongoose = require('mongoose');

const { Account, Friendship } = require('../models');
const { asyncHandler } = require('../middleware/error');
const { requireAuth } = require('../middleware/auth');
const { eventManager } = require('../middleware/eventAuth');
const emailService = require('../services/email');
const env = require('../config/env');
const invites = require('../services/invites');

// Event invites (mounts at /api/events). A host invites people by email (or from
// their friends list). Each invite is a *pending reference* only — no account or
// roster identity is created here. The invitee gets a link to /invite/<token>
// where they register (new email) or log in (existing) and are then connected to
// the event. Emails are best-effort; the links are always returned so the host
// can copy/share them when email isn't configured (or hasn't sent).
const router = express.Router();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function frontendBase() {
  const raw = env.frontendUrl || 'http://localhost:3000';
  return raw.split(',')[0].trim().replace(/\/$/, '');
}

async function sendInviteEmail(email, event, link) {
  if (!emailService.isEnabled() || !email) return false;
  try {
    await emailService.send({
      to: email,
      subject: `You're invited to ${event.name} — ${env.appName}`,
      html: emailService.wrapTemplate({
        title: `You're invited to ${event.name}!`,
        intro: 'Click to register (or log in) and join the event.',
        ctaUrl: link,
        ctaLabel: 'Join the event',
      }),
      text: `You're invited to ${event.name}. Join here: ${link}`,
    });
    return true;
  } catch (e) {
    console.error('Invite mail failed:', e.message);
    return false;
  }
}

// POST /api/events/:id/invites — body { invites?: [{ email, name? }], accountIds?: [friendId] }.
router.post('/:id/invites', requireAuth, eventManager, asyncHandler(async (req, res) => {
  const event = req.targetEvent;
  const list = Array.isArray(req.body?.invites) ? req.body.invites.slice(0, 50) : [];
  const accountIds = Array.isArray(req.body?.accountIds) ? req.body.accountIds.slice(0, 50) : [];

  const targets = list.map((i) => ({
    email: (i?.email || '').toLowerCase().trim(),
    name: (i?.name || '').trim() || null,
  }));

  // Friends (by account id) — must actually be the host's friend; resolved to email.
  for (const aid of accountIds) {
    if (!mongoose.Types.ObjectId.isValid(aid)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await Friendship.exists({ account: req.user.id, friend: aid }))) continue;
    // eslint-disable-next-line no-await-in-loop
    const acct = await Account.findById(aid).select('email displayName username');
    if (acct) targets.push({ email: acct.email.toLowerCase(), name: acct.displayName || acct.username });
  }

  const results = [];
  const seen = new Set();
  for (const t of targets) {
    if (!EMAIL_RE.test(t.email)) {
      results.push({ email: t.email || null, ok: false, error: 'Invalid email' });
      continue;
    }
    if (seen.has(t.email)) continue;
    seen.add(t.email);
    // eslint-disable-next-line no-await-in-loop
    const raw = await invites.createInvite({
      email: t.email, eventId: event._id, invitedBy: req.user.id, name: t.name,
    });
    const link = `${frontendBase()}/invite/${raw}`;
    // eslint-disable-next-line no-await-in-loop
    const emailed = await sendInviteEmail(t.email, event, link);
    results.push({ email: t.email, name: t.name || t.email.split('@')[0], link, emailed, ok: true });
  }

  res.json({ invited: results, emailEnabled: emailService.isEnabled() });
}));

module.exports = router;
