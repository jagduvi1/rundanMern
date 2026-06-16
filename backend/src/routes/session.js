const express = require('express');

// Access-code probe — the port of rundan's GET /api/session/verify. This route is
// NOT in the access-gate's public allowlist, so simply REACHING it means the
// shared site code already passed the global gate (a wrong/missing code is
// rejected upstream with 401). The SPA's AccessGate calls this to confirm a code
// before storing it.
const router = express.Router();

// GET /api/session/verify → { ok: true }.
router.get('/verify', (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
