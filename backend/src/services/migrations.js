// One-time, idempotent data migrations run at startup (after connectDB). Each is
// safe to run on every boot — a no-op once its work is done.

const env = require('../config/env');
const {
  User, Account, Event, EventMember,
} = require('../models');

// Give every roster User an `owner` (the account that "has" them) and replace the
// legacy global-unique name index with a per-owner one.
//
// Backfill strategy ("by usage, admin gets the rest"):
//   1. the owner of an event the user is a member of (earliest membership wins);
//   2. otherwise the primary admin account (first ADMIN_EMAILS match), else the
//      oldest account. Users with no signal at all (no event, no account exists)
//      are left unowned — the partial index exempts them and they stay invisible
//      until claimed.
async function migrateUserOwnership() {
  const coll = User.collection;

  // 1) Drop the legacy { name } unique index (it enforced GLOBAL uniqueness).
  try {
    const indexes = await coll.indexes();
    if (indexes.some((i) => i.name === 'name_1')) {
      await coll.dropIndex('name_1');
      console.log('[migration] dropped legacy unique index users.name_1');
    }
  } catch (e) {
    // Collection may not exist yet on a fresh DB — nothing to drop.
    if (e && e.codeName !== 'NamespaceNotFound') {
      console.error('[migration] index check failed:', e.message);
    }
  }

  // 2) Backfill owner for any users missing it.
  const unowned = await User.find({ owner: { $in: [null, undefined] } }).select('_id').lean();
  if (unowned.length) {
    const unownedIds = unowned.map((u) => u._id);

    // a) by usage — the owner of an event they belong to (earliest membership).
    const ems = await EventMember.find({ userId: { $in: unownedIds } })
      .select('userId eventId').sort({ _id: 1 }).lean();
    const eventIds = [...new Set(ems.map((m) => String(m.eventId)))];
    const events = await Event.find({ _id: { $in: eventIds } }).select('owner').lean();
    const ownerByEvent = {};
    for (const e of events) ownerByEvent[String(e._id)] = e.owner ? String(e.owner) : null;
    const ownerByUser = {};
    for (const m of ems) {
      const k = String(m.userId);
      if (!ownerByUser[k] && ownerByEvent[String(m.eventId)]) {
        ownerByUser[k] = ownerByEvent[String(m.eventId)];
      }
    }

    // b) fallback admin for users not used in any owned event.
    let fallback = null;
    if (env.adminEmails.length) {
      const a = await Account.findOne({ email: { $in: env.adminEmails } })
        .sort({ _id: 1 }).select('_id').lean();
      if (a) fallback = a._id;
    }
    if (!fallback) {
      const a = await Account.findOne().sort({ _id: 1 }).select('_id').lean();
      if (a) fallback = a._id;
    }

    let assigned = 0;
    let stranded = 0;
    for (const u of unowned) {
      const owner = ownerByUser[String(u._id)] || fallback;
      if (owner) {
        // eslint-disable-next-line no-await-in-loop
        await User.updateOne({ _id: u._id }, { $set: { owner } });
        assigned += 1;
      } else {
        stranded += 1;
      }
    }
    console.log(
      `[migration] roster ownership: assigned ${assigned} user(s)`
      + (stranded ? `, ${stranded} left unowned (no account to assign to)` : ''),
    );
  }

  // 3) Ensure the per-owner unique index exists (idempotent; existing names were
  //    globally unique, so no per-owner collisions can occur).
  try {
    await coll.createIndex(
      { owner: 1, name: 1 },
      { unique: true, partialFilterExpression: { owner: { $type: 'objectId' } } },
    );
  } catch (e) {
    console.error('[migration] could not create owner+name index:', e.message);
  }
}

module.exports = { migrateUserOwnership };
