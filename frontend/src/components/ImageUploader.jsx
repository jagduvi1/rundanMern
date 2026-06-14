// ImageUploader — upload an image (≤5 MB) and bind the resulting URL. The React
// port of rundan's ImageUploader.razor. Shows the current image, a file picker that
// POSTs to /api/admin/upload (via uploadImage → { url }) and emits the URL, plus a
// remove button. Type + size are validated client-side before upload.
//
// Props:
//   value    : string | null — current image URL (shown as a preview when set).
//   onChange : (url: string | null) => void — emits the new URL, or null on remove.
import { useRef, useState } from 'react';
import { uploadImage } from '../api/maintenance';
import { ApiError } from '../api/client';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

export default function ImageUploader({ value, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  async function onFile(e) {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file again re-fires change.
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;

    setError(null);
    if (!file.type || !file.type.startsWith('image/')) {
      setError('Välj en bildfil.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('Bilden är för stor (max 5 MB).');
      return;
    }

    setBusy(true);
    try {
      const res = await uploadImage(file);
      onChange?.(res?.url || null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Bilden kunde inte laddas upp (max 5 MB).');
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    setError(null);
    onChange?.(null);
  }

  return (
    <div className="stack">
      {value ? (
        <img
          src={value}
          alt=""
          style={{ maxHeight: 160, borderRadius: 'var(--radius-sm, 10px)', border: '1px solid var(--border)' }}
        />
      ) : null}

      {error ? <div className="error-text">{error}</div> : null}

      <div className="row wrap">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          onChange={onFile}
          disabled={busy}
        />
        {busy ? (
          <span className="muted">Laddar upp…</span>
        ) : value ? (
          <button type="button" className="btn ghost sm" onClick={clear}>Ta bort</button>
        ) : null}
      </div>
    </div>
  );
}
