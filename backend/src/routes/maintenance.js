const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

// MaintenanceEndpoints + the admin upload/seed/verify handlers — the MERN port of
// rundan's MaintenanceEndpoints.cs (clean-and-seed) plus the BootstrapEndpoints
// admin actions that live under `/api/admin` (upload, seed, verify). Mounted under
// `/api/admin` (see app.js); only this router's sub-paths are defined here.
//
// Auth model (hybrid port): the original gated these by the shared admin code.
// Here `verify`/`seed`/`clean-and-seed` require a logged-in admin account
// (`requireAdmin`); the destructive wipe additionally needs the host to type the
// server-side seed code. `upload` uses `canUpload` (any host account / event-admin
// member token; open in dev) — faithfully NOT admin-gated.
const env = require('../config/env');
const { uploadsDir } = require('../config/paths');
const models = require('../models');
const { RuleViolation, asyncHandler } = require('../middleware/error');
const { optionalAuth, requireAdmin } = require('../middleware/auth');
const { canUpload } = require('../middleware/eventAuth');
const { timingSafeEqualStr } = require('../utils/security');
const dataSeeder = require('../services/dataSeeder');
const librarySeeder = require('../services/librarySeeder');

const router = express.Router();

// ── Image upload (POST /api/admin/upload) ──────────────────────────────────────
//
// multipart/form-data, field `file`. Saved to the uploads dir as <guidN><ext>
// (32-hex random + original ext). Max 5 MB; extension in the image allow-list.

const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Ensure the uploads dir exists (server.js also creates it on boot).
    fs.mkdir(uploadsDir, { recursive: true }, (err) => cb(err, uploadsDir));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
  },
});

const uploadImage = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      // Surface the spec's exact message via the error handler below.
      cb(new RuleViolation('Use a JPG, PNG, GIF, WEBP or SVG image.'));
      return;
    }
    cb(null, true);
  },
}).single('file');

// Authorize BEFORE multer parses, so an unauthorized caller never writes a file.
const ensureCanUpload = asyncHandler(async (req, res, next) => {
  if (!(await canUpload(req))) {
    return res.status(403).json({ error: 'Only the host or an event admin can do this.' });
  }
  return next();
});

// POST /api/admin/upload — returns UploadResultDto { url: "/uploads/<name>" }.
router.post(
  '/upload',
  optionalAuth,
  ensureCanUpload,
  (req, res, next) => {
    uploadImage(req, res, (err) => {
      if (err) {
        // Map multer's size limit + our extension reject to 400s with the
        // spec's wording; anything else falls through to the error handler.
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return next(new RuleViolation('Image is too large (max 5 MB).'));
        }
        return next(err);
      }
      if (!req.file) {
        return next(new RuleViolation('No file was uploaded.'));
      }
      return res.json({ url: `/uploads/${req.file.filename}` });
    });
  }
);

// ── Seed on demand (POST /api/admin/seed) ──────────────────────────────────────

// Seeds sample data; no-op if data already exists. Returns { seeded }.
router.post(
  '/seed',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const seeded = await dataSeeder.seedIfEmpty();
    res.json({ seeded });
  })
);

// ── Clean and seed (POST /api/admin/clean-and-seed) — destructive ──────────────
//
// Wipe every domain collection, then re-seed the question library + the demo day.
// Guarded by a confirmation code the host must type (env.seedCode), compared in
// constant time. Auth-infra collections (Account/Token) and AppSetting survive so
// the host stays logged in and saved settings persist — only domain data is wiped.

// Every domain collection behind the gameplay DTOs (mirrors the .NET "every mapped
// table" wipe, minus the accounts/settings infra). Order is irrelevant — Mongo has
// no FK enforcement.
const DOMAIN_MODELS = [
  'Answer', 'ScoreEntry', 'BracketMatch', 'Question', 'Participant', 'Slap',
  'ChatMessage', 'ActivityPhoto', 'PushSubscription', 'EventViewer',
  'Activity', 'EventMember', 'Event', 'User',
  'QuestionTemplateUsage', 'QuestionTemplate', 'SpotifyConnection',
];

async function wipeDomainCollections() {
  for (const name of DOMAIN_MODELS) {
    const model = models[name];
    if (model) {
      // eslint-disable-next-line no-await-in-loop
      await model.deleteMany({});
    }
  }
}

router.post(
  '/clean-and-seed',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const code = (req.body?.code ?? '').toString().trim();
    if (!timingSafeEqualStr(code, env.seedCode)) {
      return res.status(403).json({ error: "That's not the right code." });
    }

    await wipeDomainCollections();
    // The seeders only insert because we just emptied the store (each no-ops on a
    // non-empty DB). Library first, then the demo day — matching the .NET order.
    const libSeeded = await librarySeeder.seedIfEmpty();
    const seeded = await dataSeeder.seedIfEmpty();

    return res.json({ ok: true, seeded, librarySeeded: libSeeded });
  })
);

// ── Host-panel gate probe (GET /api/admin/verify) ──────────────────────────────

// No-op confirmation used by the host-panel gate (reaching it = admin).
router.get(
  '/verify',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json({ ok: true });
  })
);

module.exports = router;
