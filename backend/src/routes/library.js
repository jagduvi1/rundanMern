// QuestionLibraryEndpoints — the MERN port of
// Rundan.Server/Endpoints/QuestionLibraryEndpoints.cs.
//
// The pre-generated question library: list the available tags, count how many
// unused questions match a tag filter, and pull a random batch into a Draft
// quiz/tipspromenad (marking them used so they aren't drawn twice).
//
// This router mounts at the bare base `/api` (see app.js), so each route below
// declares its FULL sub-path. Tags + availability are answer-free, so they are
// access-gated only (the global gate); the generate route authorizes "host OR
// event admin" via `activityManager`.
const express = require('express');

const { asyncHandler } = require('../middleware/error');
const { activityManager } = require('../middleware/eventAuth');
const questionLibrary = require('../services/questionLibrary');

const router = express.Router();

// ── Tag picker + availability (no answers leaked → access-gated only) ──────────

// GET /api/question-library/tags — distinct library tags, ascending.
router.get('/question-library/tags', asyncHandler(async (req, res) => {
  res.json(await questionLibrary.listTags());
}));

// GET /api/question-library/available?tags=a,b,c — count of unused templates
// matching the (comma-separated) tag filter. Empty/absent tags → the whole
// unused library.
router.get('/question-library/available', asyncHandler(async (req, res) => {
  const tags = String(req.query.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  res.json(await questionLibrary.availableCount(tags));
}));

// ── Generate: pull N random matching questions into a Draft activity ──────────

// POST /api/activities/:id/questions/from-library — LibraryGenerateRequest
// { count, tags } → LibraryGenerateResult { added, available }. The service
// enforces the type (Quiz/Tipspromenad), the Draft-only status, and count >= 1.
router.post('/activities/:id/questions/from-library', activityManager, asyncHandler(async (req, res) => {
  const r = req.body || {};
  const result = await questionLibrary.generate(req.targetActivity, {
    count: r.count != null ? r.count : 10,
    tags: Array.isArray(r.tags) ? r.tags : [],
  });
  res.json(result);
}));

module.exports = router;
