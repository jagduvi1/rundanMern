// PhotoWall — a shared photo grid for one activity. Joined players take/upload a
// photo (camera on mobile), everyone sees them; the uploader or a host can delete.
//
// The React port of rundan's PhotoWall.razor.
//
// Props:
//   activity   : ActivityDto — { id, ... } (its id keys the photo wall + token).
//   participant: ParticipantDto | null — { id, displayName } (null = spectator,
//                view-only).
//   canManage  : boolean — host may delete anyone's photo (server-combined upstream).
//
// ActivityPhotoDto: { id, author, url, createdUtc }
import { useEffect, useRef, useState } from 'react';
import { getPhotos, uploadPhoto, deletePhoto } from '../api/gameplay';
import { ApiError } from '../api/client';
import Spinner from './Spinner';
import ConfirmDialog from './ConfirmDialog';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB, same cap as rundan.

// "HH:mm" in the viewer's local time.
function localTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function PhotoWall({ activity, participant, canManage = false }) {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null); // photo awaiting confirm
  const fileRef = useRef(null);

  // (Re)load the wall whenever the activity changes.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    getPhotos(activity.id)
      .then((list) => {
        if (alive) setPhotos(Array.isArray(list) ? list : []);
      })
      .catch((e) => {
        // A missing/unavailable wall is not a hard error.
        if (alive && !(e instanceof ApiError && e.status === 404)) {
          setError(e?.message || 'Kunde inte ladda bilderna.');
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activity.id]);

  // The host can remove any photo; a player can remove their own (server enforces too).
  const canDelete = (p) =>
    canManage || (participant != null && participant.displayName === p.author);

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    // Reset the input so re-picking the same file fires onChange again.
    if (fileRef.current) fileRef.current.value = '';
    if (!participant || !file) return;

    if (file.size > MAX_BYTES) {
      setError('Kunde inte ladda upp bilden (max 8 MB).');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const photo = await uploadPhoto(activity.id, file);
      setPhotos((prev) => [photo, ...prev]); // newest first
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Kunde inte ladda upp bilden (max 8 MB).',
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    const p = pendingDelete;
    setPendingDelete(null);
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      await deletePhoto(activity.id, p.id);
      setPhotos((prev) => prev.filter((x) => String(x.id) !== String(p.id)));
    } catch (err) {
      setError(err?.message || 'Kunde inte ta bort bilden.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Bilder</h2>

      {error ? <div style={errorBox}>{error}</div> : null}

      {loading ? (
        <div className="center muted" style={{ padding: '1rem' }}>
          <Spinner />
        </div>
      ) : photos.length > 0 ? (
        <div style={grid}>
          {photos.map((p) => (
            <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <a href={p.url} target="_blank" rel="noopener noreferrer">
                <img src={p.url} alt="" loading="lazy" style={thumb} />
              </a>
              <div style={caption}>
                <span style={author}>
                  {p.author} · {localTime(p.createdUtc)}
                </span>
                {canDelete(p) ? (
                  <button
                    type="button"
                    onClick={() => setPendingDelete(p)}
                    disabled={busy}
                    title="Ta bort bild"
                    style={deleteBtn}
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted center" style={{ margin: 0 }}>
          Inga bilder än — bli först! 📷
        </p>
      )}

      {participant ? (
        <label className="btn soft sm" style={{ cursor: 'pointer', alignSelf: 'flex-start' }}>
          {busy ? 'Laddar upp…' : '📷 Lägg till en bild'}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onFile}
            disabled={busy}
            style={{ display: 'none' }}
          />
        </label>
      ) : null}

      <ConfirmDialog
        open={pendingDelete != null}
        title="Ta bort bilden?"
        message="Det går inte att ångra."
        confirmLabel="Ta bort"
        cancelLabel="Avbryt"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
  gap: 8,
};
const thumb = {
  width: '100%',
  aspectRatio: '1',
  objectFit: 'cover',
  borderRadius: 'var(--radius-md, 12px)',
  border: '1px solid var(--border)',
  display: 'block',
};
const caption = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: '.62rem',
  lineHeight: 1.15,
  color: 'var(--text-muted)',
};
const author = {
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const deleteBtn = {
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  color: 'var(--danger)',
  padding: 0,
  fontSize: '.8rem',
  lineHeight: 1,
};
const errorBox = {
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm, 8px)',
  background: '#fee2e2',
  color: '#991b1b',
  fontWeight: 600,
};
