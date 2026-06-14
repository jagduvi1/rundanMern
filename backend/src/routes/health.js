const express = require('express');

const router = express.Router();

// Public, ungated — used by Docker/load-balancer healthchecks.
router.get('/', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

module.exports = router;
