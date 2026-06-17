// Library — "/library" — the host's reusable activity library (host-only, wrapped
// in ProtectedRoute). Two sections: "Mitt bibliotek" (my own saved templates, each
// with a make-public toggle + reuse + edit + delete) and "Delade publikt" (templates
// other hosts have shared, browsable + reusable). Templates are created by ticking
// "Lägg till i biblioteket" on an activity (see Manage), which snapshots a standalone
// copy here. Reusing one deep-copies it into one of your events as a fresh draft.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getMyLibrary, getPublicLibrary, setLibraryVisibility, deleteActivity, getActivityUsedIn,
} from '../api/activities';
import { listEvents, addActivityFromLibrary } from '../api/events';
import { typeLabel } from '../utils/format';
import { useToast } from '../components/Toast';
import { useDocumentTitle } from '../utils/useDocumentTitle';

export default function Library() {
  useDocumentTitle('Bibliotek · Rundan');
  const { toast, show } = useToast();

  const [mine, setMine] = useState([]);
  const [pub, setPub] = useState([]);
  const [events, setEvents] = useState([]);
  const [usedIn, setUsedIn] = useState({}); // templateId -> [{ id, name }] (events using copies)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null); // id currently mutating (toggle/delete/reuse)
  const [reuseFor, setReuseFor] = useState(null); // activity id being copied into an event
  const [reuseTarget, setReuseTarget] = useState(''); // chosen event id
  const [confirmDel, setConfirmDel] = useState(null); // my template id pending delete

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [m, p, ev] = await Promise.all([
        getMyLibrary(),
        getPublicLibrary(),
        listEvents().catch(() => []),
      ]);
      setMine(m || []);
      setPub(p || []);
      setEvents(ev || []);
      // Which events use copies of each of my templates (best-effort, per template).
      const pairs = await Promise.all((m || []).map(async (t) => {
        try { return [t.id, await getActivityUsedIn(t.id)]; } catch { return [t.id, []]; }
      }));
      setUsedIn(Object.fromEntries(pairs));
    } catch (e) {
      setError(e?.message || 'Kunde inte ladda biblioteket.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const togglePublic = async (a) => {
    setBusyId(a.id);
    try {
      await setLibraryVisibility(a.id, !a.isPublic);
      show(a.isPublic ? 'Inte längre publik.' : 'Nu publik — alla värdar kan hitta den.');
      await load();
    } catch (e) {
      show(e?.message || 'Kunde inte ändra delning.');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id) => {
    setBusyId(id);
    try {
      await deleteActivity(id);
      setConfirmDel(null);
      show('Borttagen ur biblioteket.');
      await load();
    } catch (e) {
      show(e?.message || 'Kunde inte ta bort.');
    } finally {
      setBusyId(null);
    }
  };

  const startReuse = (a) => {
    setReuseFor(a.id);
    setReuseTarget(events[0]?.id || '');
  };

  const confirmReuse = async (a) => {
    if (!reuseTarget) return;
    setBusyId(a.id);
    try {
      await addActivityFromLibrary(reuseTarget, a.id);
      const ev = events.find((e) => e.id === reuseTarget);
      show(`Kopia tillagd i ${ev ? ev.name : 'evenemanget'}.`);
      setReuseFor(null);
    } catch (e) {
      show(e?.message || 'Kunde inte lägga till i evenemanget.');
    } finally {
      setBusyId(null);
    }
  };

  // Inline event picker shown under the card being reused.
  const reusePicker = (a) => (
    <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
      {events.length === 0 ? (
        <span className="muted small">
          Du har inga evenemang än — <Link to="/create">skapa ett</Link> först.
        </span>
      ) : (
        <>
          <select
            className="grow"
            value={reuseTarget}
            onChange={(e) => setReuseTarget(e.target.value)}
            aria-label="Välj evenemang"
          >
            {events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <button type="button" className="btn sm" disabled={busyId === a.id || !reuseTarget} onClick={() => confirmReuse(a)}>
            {busyId === a.id ? 'Lägger till…' : 'Lägg till'}
          </button>
        </>
      )}
      <button type="button" className="btn ghost sm" onClick={() => setReuseFor(null)}>Avbryt</button>
    </div>
  );

  const mineCard = (a) => (
    <div key={a.id} className="card stack" style={{ background: 'var(--surface-2)', gap: 8 }}>
      <div className="spread">
        <h3 style={{ margin: 0 }}>
          {a.title} <span className="muted small">· {typeLabel(a.type)}</span>
        </h3>
        {a.isPublic ? <span style={badgeStyle}>Publik</span> : <span className="muted small">Privat</span>}
      </div>
      {a.description ? <div className="muted small">{stripTags(a.description)}</div> : null}
      {(usedIn[a.id] || []).length > 0 ? (
        <div className="muted small">
          Används i:{' '}
          {usedIn[a.id].map((e, i) => (
            <span key={e.id}>
              {i > 0 ? ', ' : ''}
              <Link to={`/e/${e.id}`}>{e.name}</Link>
            </span>
          ))}
        </div>
      ) : null}
      <div className="row wrap" style={{ gap: 6 }}>
        <button type="button" className="btn sm" disabled={busyId === a.id} onClick={() => togglePublic(a)}>
          {a.isPublic ? 'Gör privat' : 'Gör publik'}
        </button>
        <button type="button" className="btn ghost sm" onClick={() => startReuse(a)}>Använd i ett evenemang</button>
        <Link to={`/manage/${a.id}`} className="btn ghost sm">Redigera</Link>
        {confirmDel === a.id ? (
          <>
            <span className="muted small">Ta bort?</span>
            <button type="button" className="btn danger sm" disabled={busyId === a.id} onClick={() => remove(a.id)}>Ja</button>
            <button type="button" className="btn ghost sm" onClick={() => setConfirmDel(null)}>Nej</button>
          </>
        ) : (
          <button type="button" className="btn ghost sm" onClick={() => setConfirmDel(a.id)}>Ta bort</button>
        )}
      </div>
      {reuseFor === a.id ? reusePicker(a) : null}
    </div>
  );

  const publicCard = (a) => (
    <div key={a.id} className="card stack" style={{ background: 'var(--surface-2)', gap: 8 }}>
      <div className="spread">
        <h3 style={{ margin: 0 }}>
          {a.title} <span className="muted small">· {typeLabel(a.type)}</span>
        </h3>
        <span className="muted small">av {a.ownerName || 'Okänd'}</span>
      </div>
      {a.description ? <div className="muted small">{stripTags(a.description)}</div> : null}
      <div className="row wrap" style={{ gap: 6 }}>
        <button type="button" className="btn sm" onClick={() => startReuse(a)}>Använd i ett evenemang</button>
      </div>
      {reuseFor === a.id ? reusePicker(a) : null}
    </div>
  );

  // Public list excludes my own (those already show, editable, in "Mitt bibliotek").
  const othersPublic = pub.filter((a) => !a.isMine);

  return (
    <div className="stack" style={{ gap: 16 }}>
      {toast}

      <div className="stack" style={{ gap: 4 }}>
        <h1 style={{ margin: 0 }}>Bibliotek</h1>
        <p className="muted small" style={{ margin: 0 }}>
          Återanvändbara aktiviteter. Spara en aktivitet hit med “Lägg till i biblioteket”, gör den
          publik för att dela med andra värdar, och lägg in valfri aktivitet i dina evenemang.
        </p>
      </div>

      {error ? <div className="error-text">{error}</div> : null}
      {loading ? <p className="muted">Laddar…</p> : (
        <>
          <div className="card stack">
            <h2 style={{ margin: 0 }}>Mitt bibliotek</h2>
            {mine.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                Inga sparade aktiviteter än. Öppna en aktivitet och välj “Lägg till i biblioteket”.
              </p>
            ) : (
              <div className="stack" style={{ gap: 8 }}>{mine.map(mineCard)}</div>
            )}
          </div>

          <div className="card stack">
            <h2 style={{ margin: 0 }}>Delade publikt</h2>
            {othersPublic.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>Inga publikt delade aktiviteter än.</p>
            ) : (
              <div className="stack" style={{ gap: 8 }}>{othersPublic.map(publicCard)}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const badgeStyle = {
  fontSize: 12,
  fontWeight: 700,
  padding: '2px 8px',
  borderRadius: 999,
  background: 'var(--accent, #2563eb)',
  color: '#fff',
};

// A library template's description may contain authored HTML; show a short, plain
// preview — strip tags and clamp to one muted line.
function stripTags(html) {
  const text = String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}
