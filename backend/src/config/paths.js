const path = require('path');
const fsp = require('fs').promises;
const env = require('./env');

// Resolved filesystem paths shared by app.js (static serving) and server.js
// (directory creation). Uploads default to backend/uploads unless overridden.
const uploadsDir = env.uploadsDir || path.join(__dirname, '..', '..', 'uploads');

// Map a stored upload URL ("/uploads/<name>") to its on-disk path, or null when
// the value isn't a local upload (external URL / blank). basename() guards against
// path traversal — we only ever touch a file directly inside uploadsDir.
function uploadPathFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (!url.includes('/uploads/')) return null;
  const name = path.basename(url.split('?')[0].split('#')[0]);
  if (!name || name === '.' || name === '..') return null;
  return path.join(uploadsDir, name);
}

// Best-effort delete of a batch of uploaded files (event/activity images, photos)
// by their stored URLs. Async (non-blocking) so a delete request doesn't stall the
// event loop. An orphaned/missing file is harmless, so every failure is ignored —
// port of StoragePaths.DeleteUploads.
async function deleteUploads(urls) {
  await Promise.all((urls || []).map(async (url) => {
    const full = uploadPathFromUrl(url);
    if (!full) return;
    try { await fsp.unlink(full); } catch { /* ignore — orphan/missing is harmless */ }
  }));
}

// Empty the uploads directory (port of StoragePaths.ClearUploads) — used by the
// destructive clean-and-seed so reset doesn't leave orphaned images behind. Async
// so it doesn't block the event loop while scanning a large uploads dir.
async function clearUploads() {
  let names;
  try {
    names = await fsp.readdir(uploadsDir);
  } catch {
    return; // dir doesn't exist yet — nothing to clear
  }
  await Promise.all(names.map(async (name) => {
    try {
      const full = path.join(uploadsDir, name);
      const st = await fsp.stat(full);
      if (st.isFile()) await fsp.unlink(full);
    } catch { /* ignore */ }
  }));
}

module.exports = { uploadsDir, deleteUploads, clearUploads, uploadPathFromUrl };
