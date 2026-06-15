const crypto = require('crypto');
const { Token } = require('../models');
const env = require('../config/env');

// Single-use passwordless login links (the "magic link"). Used by auth.js
// (a returning player requests a login link) and by the event-invite flow (a
// host invites a friend by email — the link both logs them in and lands them in
// the event). Only the SHA-256 hash is stored; a TTL index purges expired rows.

const INVITE_TTL_MS = 2 * 24 * 60 * 60 * 1000; // invites valid 2 days (shrinks the interception window)
const LOGIN_TTL_MS = 15 * 60 * 1000; // a self-requested login link: 15 min

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function canonicalFrontendUrl() {
  const raw = env.frontendUrl || 'http://localhost:3000';
  return raw.split(',')[0].trim().replace(/\/$/, '');
}

async function createMagicLink({ accountId, eventId = null, ttlMs = LOGIN_TTL_MS }) {
  const raw = crypto.randomBytes(32).toString('hex');
  await Token.create({
    account: accountId,
    kind: 'magic-link',
    eventId,
    tokenHash: hash(raw),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return raw;
}

// Atomically consume (single-use): returns the Token doc { account, eventId } or null.
async function consumeMagicLink(token) {
  if (!token || typeof token !== 'string') return null;
  return Token.findOneAndUpdate(
    { tokenHash: hash(token), kind: 'magic-link', usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { new: true }
  );
}

const magicLinkUrl = (raw) => `${canonicalFrontendUrl()}/magic-link?token=${raw}`;

module.exports = { createMagicLink, consumeMagicLink, magicLinkUrl, INVITE_TTL_MS, LOGIN_TTL_MS };
