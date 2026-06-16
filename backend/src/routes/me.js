const express = require('express');

const { Account, User, EventMember } = require('../models');
const { asyncHandler } = require('../middleware/error');
const { requireAuth } = require('../middleware/auth');
const { buildStandings } = require('../services/standings');

// The logged-in account's own profile + cross-event stats (mounts at /api/me).
// Stats reuse buildStandings so team points + slaps are correctly distributed to
// each member — the same numbers a player sees on the live event standings.
const router = express.Router();

// GET /api/me — profile (account + linked roster name + whether a password is set).
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const account = await Account.findById(req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  let playerName = account.displayName || null;
  if (account.userId) {
    const u = await User.findById(account.userId).select('name').lean();
    if (u) playerName = u.name;
  }
  res.json({
    user: account.toJSON(),
    playerName,
    hasPassword: account.hasPassword(),
    linkedToPlayer: !!account.userId,
  });
}));

// PUT /api/me/display-name — update the account's display name.
router.put('/display-name', requireAuth, asyncHandler(async (req, res) => {
  const name = (req.body?.displayName ?? '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Display name is required.' });
  if (name.length > 60) return res.status(400).json({ error: 'Display name too long (max 60).' });
  const account = await Account.findById(req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  account.displayName = name;
  await account.save();
  res.json({ displayName: account.displayName });
}));

// GET /api/me/stats — totals across every event this account's player took part in.
router.get('/stats', requireAuth, asyncHandler(async (req, res) => {
  const account = await Account.findById(req.user.id).select('userId').lean();
  if (!account || !account.userId) {
    return res.json({ linked: false, totalPoints: 0, eventsPlayed: 0, wins: 0, events: [] });
  }
  const userId = account.userId;
  const memberships = await EventMember.find({ userId }).select('eventId').lean();

  let totalPoints = 0;
  let eventsPlayed = 0;
  let wins = 0;
  const events = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const m of memberships) {
    // eslint-disable-next-line no-await-in-loop
    const standings = await buildStandings(m.eventId);
    if (!standings) continue;
    const mine = (standings.entries || []).find((e) => String(e.userId) === String(userId));
    if (!mine || (mine.activitiesPlayed === 0 && mine.totalPoints === 0)) continue;
    eventsPlayed += 1;
    totalPoints += mine.totalPoints;
    if (mine.rank === 1) wins += 1;
    events.push({
      eventId: String(m.eventId),
      eventName: standings.name,
      totalPoints: mine.totalPoints,
      rank: mine.rank,
      activitiesPlayed: mine.activitiesPlayed,
    });
  }
  // Most recent / highest first isn't tracked here; sort by points desc as a default.
  events.sort((a, b) => b.totalPoints - a.totalPoints);

  res.json({ linked: true, totalPoints, eventsPlayed, wins, events });
}));

module.exports = router;
