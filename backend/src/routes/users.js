const express = require('express');

// UserEndpoints (/api/users) — the roster. The MERN port of rundan's
// UserEndpoints.cs. A `User` is a pre-registered roster person (`UserDto =
// { id, name }`), NOT an auth account. In the original these were gated by the
// shared admin code; in the port, roster management requires a logged-in host
// (`requireAuth` — a global `admin` account, or any authenticated host), per the
// hybrid-auth model. Responses always go through `userDto`.
const { User } = require('../models');
const { userDto } = require('../services/serializers');
const { RuleViolation, asyncHandler } = require('../middleware/error');
const { requireAuth } = require('../middleware/auth');
const { deleteUserCascade } = require('../services/cascade');

const router = express.Router();

// Trim + truncate a roster name to the 60-char cap (matches the .NET name rule);
// returns the cleaned string. Throws on empty.
function cleanName(raw) {
  let name = (raw ?? '').toString().trim();
  if (name.length === 0) throw new RuleViolation('Enter a name.');
  if (name.length > 60) name = name.slice(0, 60);
  return name;
}

// POST /api/users — create a roster user.
// Auth: logged-in host (requireAuth). 409 on a duplicate exact name.
router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const name = cleanName(req.body?.name);

    if (await User.exists({ name })) {
      throw new RuleViolation('That name is already in the roster.', 409);
    }

    let user;
    try {
      user = await User.create({ name, createdUtc: new Date() });
    } catch (err) {
      // Unique-index race → same 409 the pre-check would have raised.
      if (err && err.code === 11000) {
        throw new RuleViolation('That name is already in the roster.', 409);
      }
      throw err;
    }

    res.status(201).location(`/api/users/${user._id}`).json(userDto(user));
  })
);

// GET /api/users — list all roster users, ordered by name ascending.
// Auth: logged-in host (requireAuth).
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const users = await User.find().sort({ name: 1 });
    res.json(users.map(userDto));
  })
);

// PUT /api/users/:id — rename a roster user.
// Auth: logged-in host (requireAuth). 404 if missing, 409 on a name already used
// by a DIFFERENT user. Side effect: propagate the new name into any already-formed
// team participant labels ("A & B") the user is a member of, so existing activities
// don't keep the stale snapshot.
router.put(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const name = cleanName(req.body?.name);

    if (await User.exists({ name, _id: { $ne: user._id } })) {
      throw new RuleViolation('That name is already in the roster.', 409);
    }

    user.name = name;
    await user.save();

    // Recompute the DisplayName of every TEAM participant this user belongs to:
    // members ordered by their position in the array, joined with " & ",
    // substituting the new name for this user. (Loaded lazily to avoid a hard
    // dependency cycle and to keep the hot path — no teams — cheap.)
    const { Participant } = require('../models');
    const teams = await Participant.find({ 'members.userId': user._id, isTeam: true })
      .populate('members.userId', 'name');
    for (const team of teams) {
      team.displayName = (team.members || [])
        .filter((m) => m.userId)
        .map((m) => (String(m.userId._id) === String(user._id) ? name : m.userId.name))
        .join(' & ');
      // eslint-disable-next-line no-await-in-loop
      await team.save();
    }

    return res.json(userDto(user));
  })
);

// DELETE /api/users/:id — remove a roster user.
// Auth: logged-in host (requireAuth). 404 if missing. Cascade (no Mongo FK):
// deleteUserCascade removes EventMember rows, pulls the user out of every team's
// members array, and nulls their ScoreEntry attribution.
router.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    await deleteUserCascade(user._id);
    return res.status(204).end();
  })
);

module.exports = router;
