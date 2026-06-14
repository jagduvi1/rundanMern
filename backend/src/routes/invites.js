const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');

const { Account, User, EventMember, Friendship } = require('../models');
const { asyncHandler } = require('../middleware/error');
const { requireAuth } = require('../middleware/auth');
const { eventManager } = require('../middleware/eventAuth');
const magicLink = require('../services/magicLink');
const emailService = require('../services/email');
const { eventChanged } = require('../socket/emit');
const env = require('../config/env');

// Event invites (mounts at /api/events). A host invites friends — by email, or by
// picking from their friends list — and each gets a roster identity + a
// passwordless account + a magic link that logs them in and drops them into the
// event. They can later "set a password" to keep the account, or just play.
// Emails are best-effort; the generated links are always returned so the host can
// copy/share them when no email provider is configured.
const router = express.Router();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function uniqueUsername(email) {
  const base = (String(email).split('@')[0] || 'player').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  let candidate = base.length >= 3 ? base : `player${base}`.slice(0, 20);
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await Account.exists({ username: candidate }))) return candidate;
    candidate = `${base.slice(0, 16)}${crypto.randomBytes(2).toString('hex')}`;
  }
  return `player${crypto.randomBytes(4).toString('hex')}`;
}

async function sendInviteEmail(email, event, link) {
  if (!emailService.isEnabled() || !email) return false;
  try {
    await emailService.send({
      to: email,
      subject: `You're invited to ${event.name} — ${env.appName}`,
      html: emailService.wrapTemplate({
        title: `You're invited to ${event.name}!`,
        intro: 'Tap to join and play. Afterwards you can keep an account to save your scores — or just play.',
        ctaUrl: link,
        ctaLabel: 'Join the game',
      }),
      text: `You're invited to ${event.name}: ${link}`,
    });
    return true;
  } catch (e) {
    console.error('Invite mail failed:', e.message);
    return false;
  }
}

// Add the account's player to the event roster, mint a magic link, email it.
// Returns { result, rosterChanged }.
async function inviteAccount(account, user, event) {
  const upsert = await EventMember.updateOne(
    { eventId: event._id, userId: user._id },
    { $setOnInsert: { token: crypto.randomUUID(), isAdmin: false, addedUtc: new Date() } },
    { upsert: true }
  );
  const raw = await magicLink.createMagicLink({
    accountId: account._id, eventId: event._id, ttlMs: magicLink.INVITE_TTL_MS,
  });
  const link = magicLink.magicLinkUrl(raw);
  const emailed = await sendInviteEmail(account.email, event, link);
  return {
    result: { email: account.email, name: user.name, link, emailed, ok: true },
    rosterChanged: !!upsert.upsertedCount,
  };
}

// Ensure a roster User exists for an account (create + link if missing).
async function ensureUser(account, fallbackName) {
  let user = account.userId ? await User.findById(account.userId) : null;
  if (!user) {
    const name = fallbackName || account.displayName || account.username;
    user = (await User.findOne({ name })) || (await User.create({ name }));
    account.userId = user._id;
    await account.save();
  }
  return user;
}

// POST /api/events/:id/invites — body { invites?: [{ email, name? }], accountIds?: [friendId] }.
router.post('/:id/invites', requireAuth, eventManager, asyncHandler(async (req, res) => {
  const event = req.targetEvent;
  const results = [];
  let rosterChanged = false;

  // ── Invite by email ──
  const list = Array.isArray(req.body?.invites) ? req.body.invites.slice(0, 50) : [];
  for (const inv of list) {
    const email = typeof inv?.email === 'string' ? inv.email.toLowerCase().trim() : '';
    const name = typeof inv?.name === 'string' ? inv.name.trim().slice(0, 60) : '';
    if (!EMAIL_RE.test(email)) {
      results.push({ email: inv?.email || null, ok: false, error: 'Invalid email' });
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    let account = await Account.findOne({ email });
    if (!account) {
      // eslint-disable-next-line no-await-in-loop
      const username = await uniqueUsername(email);
      const personName = name || email.split('@')[0];
      // eslint-disable-next-line no-await-in-loop
      const user = (await User.findOne({ name: personName })) || (await User.create({ name: personName }));
      // eslint-disable-next-line no-await-in-loop
      account = await Account.create({ username, email, displayName: name || user.name, roles: ['user'], userId: user._id });
      // eslint-disable-next-line no-await-in-loop
      const r = await inviteAccount(account, user, event);
      results.push(r.result);
      if (r.rosterChanged) rosterChanged = true;
    } else {
      // eslint-disable-next-line no-await-in-loop
      const user = await ensureUser(account, name);
      // eslint-disable-next-line no-await-in-loop
      const r = await inviteAccount(account, user, event);
      results.push(r.result);
      if (r.rosterChanged) rosterChanged = true;
    }
  }

  // ── Invite from friends (by account id; must be a friend of the host) ──
  const accountIds = Array.isArray(req.body?.accountIds) ? req.body.accountIds.slice(0, 50) : [];
  for (const aid of accountIds) {
    if (!mongoose.Types.ObjectId.isValid(aid)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (!(await Friendship.exists({ account: req.user.id, friend: aid }))) {
      results.push({ accountId: aid, ok: false, error: 'Not a friend' });
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const account = await Account.findById(aid);
    if (!account) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const user = await ensureUser(account);
    // eslint-disable-next-line no-await-in-loop
    const r = await inviteAccount(account, user, event);
    results.push({ ...r.result, accountId: String(aid) });
    if (r.rosterChanged) rosterChanged = true;
  }

  if (rosterChanged) eventChanged(event._id);
  res.json({ invited: results, emailEnabled: emailService.isEnabled() });
}));

module.exports = router;
