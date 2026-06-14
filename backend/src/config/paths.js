const path = require('path');
const env = require('./env');

// Resolved filesystem paths shared by app.js (static serving) and server.js
// (directory creation). Uploads default to backend/uploads unless overridden.
const uploadsDir = env.uploadsDir || path.join(__dirname, '..', '..', 'uploads');

module.exports = { uploadsDir };
