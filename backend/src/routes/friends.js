const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const { Account, Friendship } = require('../models');
const { asyncHandler } = require('../middleware/error');
const { requireAuth } = require('../middleware/auth');
const { generateUniqueFriendCode } = require('../utils/friendCode');

// Friends between accounts (mounts at /api/me). Build your circle once via a
// shareable friend code, then invite friends to events with a tap. Mirrors
// Glosan's two-row friendship, trimmed of the gamification.
const router = express.Router();
router.use(requireAuth);

// Adding by code is the brute-force-sensitive surface — cap it per IP.
const byCodeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many attempts — try again shortly.' }),
});

// GET /api/me/friends — my friends list.
router.get('/friends', asyncHandler(async (req, res) => {
  const rows = await Friendship.find({ account: req.user.id })
    .populate('friend', 'username displayName')
    .sort({ addedAt: -1 })
    .lean();
  res.json(
    rows
      .filter((r) => r.friend)
      .map((r) => ({
        id: String(r.friend._id),
        name: r.friend.displayName || r.friend.username,
        addedAt: r.addedAt,
      }))
  );
}));

// GET /api/me/friend-code — my shareable code (lazily generated on first ask).
router.get('/friend-code', asyncHandler(async (req, res) => {
  const account = await Account.findById(req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (!account.friendCode) {
    account.friendCode = await generateUniqueFriendCode(Account);
    await account.save();
  }
  res.json({ code: account.friendCode });
}));

// POST /api/me/friends/by-code — { code } → create the mutual friendship. Idempotent.
router.post('/friends/by-code', byCodeLimiter, asyncHandler(async (req, res) => {
  const code = (typeof req.body?.code === 'string' ? req.body.code : '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Enter a friend code.' });

  const target = await Account.findOne({ friendCode: code });
  if (!target) return res.status(404).json({ error: 'No one has that code.' });
  if (String(target._id) === String(req.user.id)) {
    return res.status(400).json({ error: "That's your own code 🙂" });
  }

  const now = new Date();
  await Friendship.updateOne(
    { account: req.user.id, friend: target._id },
    { $setOnInsert: { addedAt: now } },
    { upsert: true }
  );
  await Friendship.updateOne(
    { account: target._id, friend: req.user.id },
    { $setOnInsert: { addedAt: now } },
    { upsert: true }
  );

  res.json({ friend: { id: String(target._id), name: target.displayName || target.username, addedAt: now } });
}));

// DELETE /api/me/friends/:friendId — remove both rows.
router.delete('/friends/:friendId', asyncHandler(async (req, res) => {
  const { friendId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(friendId)) return res.status(400).json({ error: 'Invalid id' });
  await Friendship.deleteOne({ account: req.user.id, friend: friendId });
  await Friendship.deleteOne({ account: friendId, friend: req.user.id });
  res.status(204).end();
}));

module.exports = router;
