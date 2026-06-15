const crypto = require('crypto');
const { Invite, Account, User, EventMember } = require('../models');

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // pending invites valid 14 days
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// Create (or refresh) the pending invite for (email, event); returns the raw
// token. Re-inviting the same address replaces the old token (old link dies).
async function createInvite({ email, eventId, invitedBy = null, name = null }) {
  const raw = crypto.randomBytes(32).toString('hex');
  await Invite.findOneAndUpdate(
    { email: String(email).toLowerCase(), eventId },
    {
      $set: {
        tokenHash: hash(raw),
        invitedBy,
        name: name || null,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        acceptedAt: null,
        acceptedBy: null,
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, new: true }
  );
  return raw;
}

// The pending (unexpired, unaccepted) invite for a raw token, or null.
async function findPendingInvite(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  return Invite.findOne({ tokenHash: hash(rawToken), acceptedAt: null, expiresAt: { $gt: new Date() } });
}

// Resolve the roster User for an account without hijacking one already claimed
// by another account (mirrors the 1:1 account<->roster-user rule).
async function resolveRosterUser(account) {
  if (account.userId) {
    const existing = await User.findById(account.userId);
    if (existing) return existing;
  }
  const base = (account.displayName || account.username || 'Player').trim() || 'Player';
  let user = await User.findOne({ name: base });
  if (user && (await Account.exists({ userId: user._id, _id: { $ne: account._id } }))) user = null;
  if (!user) {
    let name = base;
    // eslint-disable-next-line no-await-in-loop
    for (let i = 2; await User.exists({ name }); i += 1) name = `${base} (${i})`;
    user = await User.create({ name });
  }
  if (String(account.userId || '') !== String(user._id)) {
    account.userId = user._id;
    await account.save();
  }
  return user;
}

// Connect an account to the invite's event: ensure a roster identity +
// membership, mark the invite accepted. Returns the eventId.
async function acceptInvite(account, invite) {
  const user = await resolveRosterUser(account);
  await EventMember.updateOne(
    { eventId: invite.eventId, userId: user._id },
    { $setOnInsert: { token: crypto.randomUUID(), isAdmin: false, addedUtc: new Date() } },
    { upsert: true }
  );
  // Atomically claim the invite (only if still unaccepted) — matches the
  // consumeMagicLink/consumeEmailToken pattern. The membership upsert above is
  // idempotent, so a concurrent accept is harmless.
  await Invite.updateOne(
    { _id: invite._id, acceptedAt: null },
    { $set: { acceptedAt: new Date(), acceptedBy: account._id } }
  );
  return invite.eventId;
}

module.exports = { createInvite, findPendingInvite, acceptInvite, INVITE_TTL_MS };
