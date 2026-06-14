// Admin — "/admin" — the host dashboard (port of rundan's Admin.razor). Stats,
// events CRUD, standalone-activity creation, Spotify setup (PKCE), and the
// danger-zone seed / clean-and-seed. Host-only (route wrapped in ProtectedRoute);
// the MERN port replaces rundan's admin-code gate with a real host account.
//
// Contract gaps vs doc 09 (no backend endpoint): there is no "list all
// activities" route, so the standalone-activities card creates + opens but cannot
// list existing ones; and there is no event-wide "add from library" copy.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listEvents, createEvent, deleteEvent } from '../api/events';
import { createActivity } from '../api/activities';
import { getLibraryAvailable, getLibraryTags } from '../api/library';
import {
  listConnections, setClientId, validateConnection, deleteConnection,
} from '../api/spotify';
import { seedDemo, cleanAndSeed } from '../api/maintenance';
import { ApiError } from '../api/client';
import { ActivityStatus, ActivityType, EventScoring, SlapMode } from '../config/enums';
import { typeLabel } from '../utils/format';
import { startLogin, redirectUri, SPOTIFY_SCOPES } from '../utils/spotifyAuth';
import { useBootstrap } from '../contexts/BootstrapContext';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import { useToast } from '../components/Toast';
import ConfirmDialog from '../components/ConfirmDialog';
import StatusBadge from '../components/StatusBadge';
import Pill from '../components/Pill';
import AdminNav from '../components/AdminNav';

const CREATE_TYPES = [
  ActivityType.Quiz, ActivityType.Tipspromenad, ActivityType.Boule, ActivityType.ScoreGame,
  ActivityType.WordGame, ActivityType.MapPin, ActivityType.MusicQuiz, ActivityType.Memory,
];

const scoringLabel = (s) => (s === EventScoring.Placement ? 'Placeringspoäng' : 'Kumulativa poäng');
const slapLabel = (m) => ({
  [SlapMode.Off]: 'Nyp av',
  [SlapMode.Vanish]: 'Nyp: försvinner',
  [SlapMode.SendToPlayer]: 'Nyp: skicka',
  [SlapMode.SlappedSends]: 'Nyp: nypt skickar',
  [SlapMode.Random]: 'Nyp: slump',
}[m] || 'Nyp av');

function statusSummary(activities) {
  const c = { live: 0, open: 0, draft: 0, done: 0 };
  for (const a of activities || []) {
    if (a.status === ActivityStatus.Live) c.live += 1;
    else if (a.status === ActivityStatus.Open) c.open += 1;
    else if (a.status === ActivityStatus.Finished) c.done += 1;
    else c.draft += 1;
  }
  const parts = [];
  if (c.live) parts.push(`${c.live} live`);
  if (c.open) parts.push(`${c.open} öppna`);
  if (c.draft) parts.push(`${c.draft} utkast`);
  if (c.done) parts.push(`${c.done} klara`);
  return parts.join(' · ');
}

export default function Admin() {
  useDocumentTitle('Värdpanel · Rundan');
  const navigate = useNavigate();
  const { toast, show } = useToast();
  const { spotifyClientId, reload } = useBootstrap();

  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [libraryCount, setLibraryCount] = useState(0);
  const [topics, setTopics] = useState(0);
  const [connections, setConnections] = useState([]);

  const [newEventName, setNewEventName] = useState('');
  const [stTitle, setStTitle] = useState('');
  const [stType, setStType] = useState(ActivityType.Quiz);
  const [clientIdInput, setClientIdInput] = useState(spotifyClientId || '');
  const [seedCode, setSeedCode] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [confirmClean, setConfirmClean] = useState(false);

  const liveCount = events.reduce(
    (n, e) => n + (e.activities || []).filter((a) => a.status === ActivityStatus.Live).length, 0,
  );
  const totalActivities = events.reduce((n, e) => n + (e.activities || []).length, 0);
  const pendingSlaps = events.filter((e) => e.pendingSlap).length;

  const load = async () => {
    setLoading(true);
    try {
      const list = await listEvents();
      setEvents(list);
    } catch (err) {
      show(err instanceof ApiError ? err.message : 'Kunde inte ladda evenemang.');
    } finally {
      setLoading(false);
    }
    // Best-effort widgets — never block the dashboard on these.
    getLibraryAvailable().then((r) => setLibraryCount(r?.count ?? (Array.isArray(r) ? r.length : 0))).catch(() => {});
    getLibraryTags().then((tags) => {
      const arr = Array.isArray(tags) ? tags : [];
      setTopics(arr.filter((t) => String(t).startsWith('topic:')).length);
    }).catch(() => {});
    if (spotifyClientId) listConnections().then(setConnections).catch(() => {});
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const addEvent = async () => {
    const name = newEventName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const ev = await createEvent({ name });
      navigate(`/e/${ev.id}`);
    } catch (err) {
      show(err?.message || 'Kunde inte skapa evenemang.');
      setBusy(false);
    }
  };

  const removeEvent = async (id) => {
    setConfirmDeleteId(null);
    setBusy(true);
    try {
      await deleteEvent(id);
      await load();
    } catch (err) {
      show(err?.message || 'Kunde inte ta bort.');
    } finally {
      setBusy(false);
    }
  };

  const addStandalone = async () => {
    const title = stTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const a = await createActivity({ title, type: stType });
      navigate(`/manage/${a.id}`);
    } catch (err) {
      show(err?.message || 'Kunde inte skapa aktivitet.');
      setBusy(false);
    }
  };

  const saveClientId = async () => {
    setBusy(true);
    try {
      await setClientId(clientIdInput.trim());
      await reload();
      show('Spotify-klient-ID sparat.');
      listConnections().then(setConnections).catch(() => {});
    } catch (err) {
      show(err?.message || 'Kunde inte spara klient-ID.');
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async (cid) => {
    try {
      await validateConnection(cid);
      show('Anslutningen fungerar.');
      listConnections().then(setConnections).catch(() => {});
    } catch (err) {
      show(err?.message || 'Testet misslyckades.');
    }
  };

  const removeConnection = async (cid) => {
    try {
      await deleteConnection(cid);
      setConnections((c) => c.filter((x) => x.id !== cid));
    } catch (err) {
      show(err?.message || 'Kunde inte ta bort anslutningen.');
    }
  };

  const connect = async () => {
    if (!spotifyClientId) return;
    try {
      await startLogin(spotifyClientId, SPOTIFY_SCOPES); // full-page redirect
    } catch (err) {
      show(err?.message || 'Kunde inte starta Spotify-inloggning.');
    }
  };

  const runSeed = async () => {
    setBusy(true);
    try {
      await seedDemo();
      show('Demodata laddat.');
      await load();
    } catch (err) {
      show(err?.message || 'Seed misslyckades.');
    } finally {
      setBusy(false);
    }
  };

  const runCleanSeed = async () => {
    setConfirmClean(false);
    const code = seedCode.trim();
    if (!code) { show('Ange bekräftelsekoden.'); return; }
    setBusy(true);
    try {
      await cleanAndSeed(code);
      setSeedCode('');
      show('Rensat och seedat.');
      await load();
    } catch (err) {
      // A timeout can leave data in an unknown state — surface that distinctly.
      show(err?.message || 'Rensningen misslyckades — data kan vara i okänt läge.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {toast}
      <AdminNav active="events" />

      {/* Stat widgets */}
      <div className="row wrap" style={{ gap: 10, marginBottom: 12 }}>
        <Stat num={events.length} label={`Evenemang`} sub={liveCount > 0 ? `${liveCount} live nu` : null} />
        <Stat num={totalActivities} label="Aktiviteter" />
        <Stat num={libraryCount} label="Frågebibliotek" sub={topics > 0 ? `${topics} ämnen` : null} />
      </div>

      {pendingSlaps > 0 ? (
        <div className="card" style={{ borderColor: 'var(--warn)' }}>
          <span className="muted">{pendingSlaps} nyp väntar på att lösas innan nästa aktivitet kan starta.</span>
        </div>
      ) : null}

      {/* Events */}
      <div className="card stack">
        <div className="spread">
          <h2 style={{ margin: 0 }}>Evenemang</h2>
          <button type="button" className="btn ghost sm" onClick={load} disabled={loading || busy}>Uppdatera</button>
        </div>

        {loading ? (
          <span className="spinner" style={{ margin: '1rem auto' }} />
        ) : events.length === 0 ? (
          <p className="muted">Inga evenemang ännu.</p>
        ) : (
          events.map((ev) => (
            <div key={ev.id} className="card stack" style={{ background: 'var(--surface-2)' }}>
              <div className="spread">
                <h3 style={{ margin: 0 }}>{ev.name} <span className="muted small">· kod {ev.joinCode}</span></h3>
                {ev.isComplete ? <Pill kind="ok">klar</Pill> : null}
                {ev.pendingSlap ? <Pill kind="warn">nyp väntar</Pill> : null}
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                <Pill>{scoringLabel(ev.scoring)}</Pill>
                <Pill>{slapLabel(ev.slapMode)}</Pill>
                <Pill>Lag om {ev.teamSize}</Pill>
                {(ev.viewers || []).length > 0 ? <Pill>{ev.viewers.length} tittar</Pill> : null}
              </div>
              {statusSummary(ev.activities) ? <div className="muted small">{statusSummary(ev.activities)}</div> : null}
              <div className="row">
                <button type="button" className="btn sm" onClick={() => navigate(`/e/${ev.id}`)}>Öppna & redigera</button>
                <button type="button" className="btn ghost sm danger" onClick={() => setConfirmDeleteId(ev.id)} disabled={busy}>Ta bort</button>
              </div>
            </div>
          ))
        )}

        <div className="row" style={{ marginTop: 8 }}>
          <input
            className="grow"
            value={newEventName}
            onChange={(e) => setNewEventName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addEvent(); }}
            placeholder="Namn på nytt evenemang"
            maxLength={80}
          />
          <button type="button" className="btn sm success" onClick={addEvent} disabled={busy || !newEventName.trim()}>Skapa</button>
        </div>
      </div>

      {/* Standalone activity (create only — no list endpoint) */}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Fristående aktivitet</h2>
        <p className="muted small">Skapa en aktivitet utan evenemang. Den öppnas direkt i hanteringsvyn.</p>
        <div className="row wrap">
          <input
            className="grow"
            value={stTitle}
            onChange={(e) => setStTitle(e.target.value)}
            placeholder="Titel"
            maxLength={80}
            style={{ minWidth: 160 }}
          />
          <select value={stType} onChange={(e) => setStType(Number(e.target.value))} style={{ width: 'auto' }}>
            {CREATE_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
          </select>
          <button type="button" className="btn sm success" onClick={addStandalone} disabled={busy || !stTitle.trim()}>Skapa</button>
        </div>
      </div>

      {/* Spotify */}
      {spotifyClientId ? (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Spotify</h2>
          <div className="field">
            <label htmlFor="spotify-client">Klient-ID</label>
            <div className="row">
              <input id="spotify-client" className="grow" value={clientIdInput} onChange={(e) => setClientIdInput(e.target.value)} />
              <button type="button" className="btn sm" onClick={saveClientId} disabled={busy}>Spara</button>
            </div>
          </div>
          {connections.length > 0 ? (
            <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 8 }}>
              {connections.map((c) => (
                <li key={c.id} className="row">
                  <span className="grow">{c.name}{c.status ? <span className="muted small"> · {c.status}</span> : null}</span>
                  <button type="button" className="btn ghost sm" onClick={() => testConnection(c.id)}>Testa</button>
                  <button type="button" className="btn ghost sm danger" onClick={() => removeConnection(c.id)}>Ta bort</button>
                </li>
              ))}
            </ul>
          ) : <p className="muted small">Inga anslutna konton ännu.</p>}
          <button type="button" className="btn soft sm" onClick={connect}>Anslut ett Spotify-konto</button>
          <details>
            <summary className="muted small">Engångsinställning</summary>
            <p className="muted small" style={{ marginTop: 8 }}>
              Registrera den här Redirect URI:n i din Spotify-app:
              <br /><code style={{ wordBreak: 'break-all' }}>{redirectUri()}</code>
            </p>
          </details>
        </div>
      ) : null}

      {/* Danger zone */}
      <div className="card stack" style={{ borderColor: 'var(--danger)' }}>
        <h2 style={{ margin: 0 }}>Farozon</h2>
        <div className="row wrap">
          <button type="button" className="btn ghost sm" onClick={runSeed} disabled={busy}>Ladda demodata</button>
        </div>
        <p className="muted small" style={{ marginTop: 4 }}>
          "Rensa & seed" raderar allt och seedar om demon på nytt. Skriv bekräftelsekoden för att fortsätta.
        </p>
        <div className="row wrap">
          <input
            className="grow"
            value={seedCode}
            onChange={(e) => setSeedCode(e.target.value)}
            placeholder="Bekräftelsekod"
            style={{ minWidth: 160 }}
          />
          <button type="button" className="btn sm danger" onClick={() => setConfirmClean(true)} disabled={busy || !seedCode.trim()}>Rensa & seed</button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteId != null}
        title="Ta bort evenemang?"
        message="Det här går inte att ångra. Allt i evenemanget tas bort."
        confirmLabel="Ta bort"
        danger
        onConfirm={() => removeEvent(confirmDeleteId)}
        onCancel={() => setConfirmDeleteId(null)}
      />
      <ConfirmDialog
        open={confirmClean}
        title="Rensa & seed om?"
        message="Detta raderar ALLT och seedar om demon. Säker?"
        confirmLabel="Rensa allt"
        danger
        onConfirm={runCleanSeed}
        onCancel={() => setConfirmClean(false)}
      />
    </>
  );
}

function Stat({ num, label, sub }) {
  return (
    <div className="card" style={{ flex: '1 1 120px', textAlign: 'center', padding: 12 }}>
      <div style={{ fontSize: '1.8rem', fontWeight: 800 }}>{num}</div>
      <div className="muted small">{label}</div>
      {sub ? <div className="muted small">{sub}</div> : null}
    </div>
  );
}
