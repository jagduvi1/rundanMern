const crypto = require('crypto');
const { Invite, Account, User, EventMember } = require('../models');

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // pending invites valid 14 days
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// Create (or refresh) the pending invite for (email, event); returns the raw
// token. Re-inviting the same address replaces the old token (old link dies).
// `userId` optionally designates the roster person this invite is for.
async function createInvite({
  email, eventId, invitedBy = null, name = null, userId = null,
}) {
  const raw = crypto.randomBytes(32).toString('hex');
  await Invite.findOneAndUpdate(
    { email: String(email).toLowerCase(), eventId },
    {
      $set: {
        tokenHash: hash(raw),
        invitedBy,
        name: name || null,
        userId: userId || null,
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

// Resolve the roster User for an account. The 1:1 account<->roster-user link is
// only ever established EXPLICITLY:
//   1. an existing account.userId link wins;
//   2. else, if the invite DESIGNATED a roster person (designatedUserId) and it
//      isn't already owned by another account, bind to THAT user;
//   3. else create a FRESH roster User (deduped by name suffix).
// Note: we deliberately do NOT adopt a pre-existing same-named roster User by
// name — that silently merged two different real people who happen to share a
// name onto one identity (and their cross-event scores). Linking to an existing
// roster person must be a deliberate act (an invite designation, or claim-link).
async function resolveRosterUser(account, designatedUserId = null) {
  if (account.userId) {
    const existing = await User.findById(account.userId);
    if (existing) return existing;
  }
  if (designatedUserId) {
    const target = await User.findById(designatedUserId);
    // Only adopt it if no OTHER account already owns it (hijack guard). Bind with
    // an atomic conditional update so a concurrent accept can't both win and
    // violate the Account.userId 1:1 partial-unique index; a raced loser (11000)
    // falls through to a fresh user.
    if (target && !(await Account.exists({ userId: target._id, _id: { $ne: account._id } }))) {
      try {
        const r = await Account.updateOne(
          { _id: account._id, $or: [{ userId: null }, { userId: target._id }] },
          { $set: { userId: target._id } },
        );
        if (r.matchedCount) { account.userId = target._id; return target; }
      } catch (e) {
        if (!(e && e.code === 11000)) throw e;
      }
    }
  }
  // Otherwise create a FRESH roster User — retry the dedupe on a name/link race so
  // accept/register never 500s on a transient duplicate-key.
  const base = (account.displayName || account.username || 'Player').trim() || 'Player';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let name = base;
    // eslint-disable-next-line no-await-in-loop
    for (let i = 2; await User.exists({ name }); i += 1) name = `${base} (${i})`;
    try {
      // eslint-disable-next-line no-await-in-loop
      const user = await User.create({ name });
      // eslint-disable-next-line no-await-in-loop
      await Account.updateOne({ _id: account._id }, { $set: { userId: user._id } });
      account.userId = user._id;
      return user;
    } catch (e) {
      if (!(e && e.code === 11000)) throw e; // name raced — recompute the suffix and retry
    }
  }
  throw new Error('Could not allocate a roster identity — please try again.');
}

// Connect an account to the invite's event: ensure a roster identity +
// membership, mark the invite accepted. Returns the eventId.
async function acceptInvite(account, invite) {
  const user = await resolveRosterUser(account, invite.userId);
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
