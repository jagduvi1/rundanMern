// Manage — "/manage/:id" — the host's full activity editor (port of rundan's
// Manage.razor). Status transitions, every type-specific setting, and the embedded
// question / track / card / courts editors (owned by sibling agents). Host-only
// (route wrapped in ProtectedRoute); management calls also carry the per-event
// member token via client.js so a co-host can edit.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useLocation } from 'react-router-dom';
import {
  getActivity, updateActivity, setActivityStatus, deleteActivity, setCourts,
  addActivityToLibrary,
} from '../api/activities';
import { resetResults } from '../api/simulation';
import { listConnections } from '../api/spotify';
import { ApiError } from '../api/client';
import {
  ActivityType, ActivityStatus, Measurement, ScoringMode, ScoreEntryMode,
  MatchFormat, TournamentScoring, ImpostureScoring,
} from '../config/enums';
import { typeLabel, rulesSummary } from '../utils/format';
import { useAuth } from '../contexts/AuthContext';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import { useToast } from '../components/Toast';
import ConfirmDialog from '../components/ConfirmDialog';
import StatusBadge from '../components/StatusBadge';

import RichTextEditor from '../components/RichTextEditor';
import ImageUploader from '../components/ImageUploader';
import LocationPicker from '../components/LocationPicker';
import QuestionEditor from '../components/QuestionEditor';
import StationsEditor from '../components/StationsEditor';
import MusicTracksEditor from '../components/MusicTracksEditor';
import MemoryCardsEditor from '../components/MemoryCardsEditor';
import ImpostureWordsEditor from '../components/ImpostureWordsEditor';

const TYPE_OPTIONS = [
  [ActivityType.Quiz, 'Quiz'],
  [ActivityType.Tipspromenad, 'Tipspromenad'],
  [ActivityType.Boule, 'Turnering (utslagning)'],
  [ActivityType.ScoreGame, 'Annat poängspel'],
  [ActivityType.WordGame, 'Ordspel'],
  [ActivityType.MapPin, 'Kartnål'],
  [ActivityType.MusicQuiz, 'Musikquiz'],
  [ActivityType.Memory, 'Memory'],
  [ActivityType.Imposture, 'Imposture'],
];

// The host's next status actions, given the current status.
function nextActions(status) {
  switch (status) {
    case ActivityStatus.Draft: return [['Öppna lobby', ActivityStatus.Open, 'success']];
    case ActivityStatus.Open: return [['Starta', ActivityStatus.Live, 'success'], ['Tillbaka till utkast', ActivityStatus.Draft, 'ghost']];
    case ActivityStatus.Live: return [['Avsluta', ActivityStatus.Finished, ''], ['Tillbaka till utkast', ActivityStatus.Draft, 'ghost']];
    case ActivityStatus.Finished: return [['Öppna igen', ActivityStatus.Live, ''], ['Tillbaka till lobby', ActivityStatus.Open, 'ghost']];
    default: return [];
  }
}

export default function Manage() {
  useDocumentTitle('Hantera · GameDo');
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast, show } = useToast();
  // Per-user Spotify: auto-fill/import is available when the host has their own Client ID.
  const { user } = useAuth();
  const spotifyClientId = user?.spotifyClientId || '';
  const [leaveTo, setLeaveTo] = useState(null); // pending navigation when there are unsaved edits

  const [activity, setActivity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connections, setConnections] = useState([]);
  const [qVersion, setQVersion] = useState(0); // bump to re-key the editors
  const [confirm, setConfirm] = useState(null); // 'delete' | 'reset' | null
  const [libBusy, setLibBusy] = useState(false); // "add to library" in flight

  // Edit fields
  const [f, setF] = useState(null);
  const set = (key) => (val) => setF((s) => ({ ...s, [key]: val }));

  // Snapshot this activity into the host's reusable library (a standalone template).
  // Saves the activity as currently stored on the server; remind the host to save
  // edits first if the form is dirty.
  async function onAddToLibrary() {
    if (!activity) return;
    setLibBusy(true);
    try {
      await addActivityToLibrary(activity.id);
      show('Sparad i ditt bibliotek ✓');
    } catch (e) {
      show(e?.message || 'Kunde inte spara till biblioteket.');
    } finally {
      setLibBusy(false);
    }
  }

  // Unsaved-changes guard: the details form differs from the saved activity.
  const dirty = useMemo(
    () => !!(activity && f && JSON.stringify(fieldsFrom(activity)) !== JSON.stringify(f)),
    [activity, f],
  );
  // Navigate, but stop to ask if there are unsaved edits.
  const guardedGo = (to) => { if (dirty) setLeaveTo(to); else navigate(to); };
  // Warn on tab close / refresh while dirty.
  useEffect(() => {
    const handler = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const isDraft = activity?.status === ActivityStatus.Draft;
  const usesQuestions = activity?.usesQuestions;
  const usesMap = activity?.usesMap;
  const usesRounds = activity?.usesRounds;
  const usesCourts = activity?.usesCourts;

  const load = async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const a = await getActivity(id);
      if (!a) { setNotFound(true); return; }
      setActivity(a);
      setF(fieldsFrom(a));
      if (a.type === ActivityType.MusicQuiz && spotifyClientId) {
        listConnections().then(setConnections).catch(() => {});
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else show(err?.message || 'Kunde inte ladda aktiviteten.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  const courts = useMemo(() => (activity?.courts || []).map((c) => c.name), [activity]);
  const [courtNames, setCourtNames] = useState([]);
  const [courtLabel, setCourtLabel] = useState('Bana');
  useEffect(() => {
    setCourtNames(courts);
    if (activity?.courtLabel) setCourtLabel(activity.courtLabel);
  }, [courts, activity]);

  const changeStatus = async (status) => {
    setBusy(true);
    try {
      const a = await setActivityStatus(id, status);
      setActivity(a);
      setF(fieldsFrom(a));
    } catch (err) {
      show(err?.message || 'Statusändring misslyckades.');
    } finally {
      setBusy(false);
    }
  };

  const testRun = async () => {
    setBusy(true);
    try {
      await setActivityStatus(id, ActivityStatus.Open);
      await setActivityStatus(id, ActivityStatus.Live);
      navigate(`/a/${id}`);
    } catch (err) {
      show(err?.message || 'Testkörning misslyckades.');
      setBusy(false);
    }
  };

  const resetToDraft = async () => {
    setConfirm(null);
    setBusy(true);
    try {
      const a = await resetResults(id);
      setActivity(a || (await getActivity(id)));
      const fresh = a || (await getActivity(id));
      if (fresh) setF(fieldsFrom(fresh));
      setQVersion((v) => v + 1);
    } catch (err) {
      show(err?.message || 'Återställningen misslyckades.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirm(null);
    setBusy(true);
    try {
      await deleteActivity(id);
      navigate('/admin');
    } catch (err) {
      show(err?.message || 'Kunde inte ta bort.');
      setBusy(false);
    }
  };

  const saveDetails = async () => {
    if (!f || !f.title.trim()) return;
    setBusy(true);
    try {
      const a = await updateActivity(id, buildBody(f));
      setActivity(a);
      setF(fieldsFrom(a));
      show('Sparat.');
    } catch (err) {
      show(err?.message || 'Kunde inte spara.');
    } finally {
      setBusy(false);
    }
  };

  const saveCourts = async () => {
    setBusy(true);
    try {
      const a = await setCourts(id, courtLabel.trim() || 'Bana', courtNames);
      setActivity(a);
      setCourtNames((a.courts || []).map((c) => c.name));
      setCourtLabel(a.courtLabel || 'Bana');
    } catch (err) {
      show(err?.message || 'Kunde inte spara banor.');
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard?.writeText(activity.joinCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  // Picking Time flips Who-wins to Lowest; switching type resets scoring.
  const onMeasurementChange = (v) => {
    setF((s) => ({
      ...s,
      measurement: v,
      scoringMode: v === Measurement.TimeSeconds && s.scoringMode === ScoringMode.HigherWins
        ? ScoringMode.LowerWins : s.scoringMode,
    }));
  };
  const onTypeChange = (v) => {
    setF((s) => ({
      ...s,
      type: v,
      scoringMode: v === ActivityType.MapPin ? ScoringMode.LowerWins : ScoringMode.HigherWins,
      measurement: Measurement.Points,
    }));
  };

  // Memory's "scored by" saves immediately (mirrors the .razor @bind:after).
  const saveMemoryMeasurement = async (v) => {
    const next = { ...f, measurement: v };
    setF(next);
    setBusy(true);
    try {
      const a = await updateActivity(id, buildBody(next));
      setActivity(a);
      setF(fieldsFrom(a));
    } catch (err) {
      show(err?.message || 'Kunde inte spara.');
    } finally {
      setBusy(false);
    }
  };

  // Imposture config (impostor count / category hint / scoring) saves immediately.
  const saveImpostureConfig = async (partial) => {
    const next = { ...f, ...partial };
    setF(next);
    setBusy(true);
    try {
      const a = await updateActivity(id, buildBody(next));
      setActivity(a);
      setF(fieldsFrom(a));
    } catch (err) {
      show(err?.message || 'Kunde inte spara.');
    } finally {
      setBusy(false);
    }
  };

  // "Jag spelar också" (hide questions/answers from the host) must take effect
  // immediately: persist it so the question endpoints mask right away, and remount
  // the editors so the already-loaded list re-fetches masked. Otherwise a host who
  // ticks it then imports questions keeps seeing the answers until they save/reload.
  const saveHideQuestions = async (checked) => {
    const next = { ...f, hideQuestionsFromHost: checked };
    setF(next);
    setBusy(true);
    try {
      const a = await updateActivity(id, buildBody(next));
      setActivity(a);
      setF(fieldsFrom(a));
      setQVersion((v) => v + 1);
    } catch (err) {
      show(err?.message || 'Kunde inte spara.');
    } finally {
      setBusy(false);
    }
  };

  const onEditorChanged = () => setQVersion((v) => v + 1);

  if (loading) {
    return (<>{toast}<div className="card center muted"><span className="spinner" style={{ margin: '1rem auto' }} /></div></>);
  }
  if (notFound || !activity || !f) {
    return (
      <>
        {toast}
        <div className="card stack">
          <h1>Hittades inte</h1>
          <p className="muted">Den aktiviteten finns inte.</p>
          <Link className="btn" to="/admin">Tillbaka till värdinställningar</Link>
        </div>
      </>
    );
  }

  const countSummary = activity.isTeamBased
    ? `${activity.teamCount} lag · ${activity.playerCount} spelare`
    : `${activity.playerCount} spelare`;

  // Where "back" goes: the setup wizard if we came from it, else the event, else the panel.
  const returnTo = location.state?.returnTo || (activity.eventId ? `/e/${activity.eventId}` : '/admin');
  const fromSetup = (location.state?.returnTo || '').startsWith('/create');
  const backLabel = fromSetup
    ? '← Tillbaka till uppsättningen'
    : activity.eventId ? '← Tillbaka till evenemanget' : '← Värdpanel';

  return (
    <>
      {toast}

      {/* Header */}
      <div className="card stack">
        <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => guardedGo(returnTo)}>
          {backLabel}
        </button>
        <div className="row">
          <h1 className="grow" style={{ margin: 0 }}>{activity.title}</h1>
          <StatusBadge status={activity.status} />
        </div>
        <div className="muted">{typeLabel(activity.type)} · {countSummary}</div>
        <div className="row wrap">
          <span className="pill accent" style={{ fontSize: '1rem' }}>{activity.joinCode}</span>
          <button type="button" className="btn ghost sm" onClick={copyCode}>{copied ? 'Kopierad ✓' : 'Kopiera kod'}</button>
          <button type="button" className="btn ghost sm" onClick={() => guardedGo(`/a/${activity.id}`)}>Öppna spelarvy</button>
          <a className="btn ghost sm" href={`/cast/${activity.id}`} target="_blank" rel="noopener noreferrer" title="Öppna storbildsvyn på en projektor/TV">📺 Casta</a>
        </div>

        <div className="row wrap">
          {nextActions(activity.status).map(([label, status, cls]) => (
            <button key={label} type="button" className={`btn ${cls}`} onClick={() => changeStatus(status)} disabled={busy}>{label}</button>
          ))}
        </div>

        {isDraft ? (
          <div className="row wrap">
            <button type="button" className="btn soft sm" onClick={testRun} disabled={busy}>▶ Testkör</button>
            <span className="muted small">Öppnar den (kort live) och tar dig till spelarvyn — återställ till utkast när du är klar.</span>
          </div>
        ) : (activity.status === ActivityStatus.Open || activity.status === ActivityStatus.Live) ? (
          <div className="row wrap">
            <button type="button" className="btn ghost sm" onClick={() => setConfirm('reset')} disabled={busy}>↺ Återställ till utkast</button>
            <span className="muted small">Nollställer poängen och går tillbaka till utkast.</span>
          </div>
        ) : null}

        <div className="row">
          <button type="button" className="btn ghost sm danger" onClick={() => setConfirm('delete')} disabled={busy}>Ta bort aktivitet</button>
        </div>
      </div>

      {/* Details */}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Detaljer</h2>
        <div className="field">
          <label htmlFor="m-title">Titel</label>
          <input type="text" id="m-title" value={f.title} onChange={(e) => set('title')(e.target.value)} maxLength={200} />
        </div>

        <div className="field">
          <label htmlFor="m-type">Aktivitetstyp</label>
          {isDraft ? (
            <>
              <select id="m-type" value={f.type} onChange={(e) => onTypeChange(Number(e.target.value))}>
                {TYPE_OPTIONS.map(([t, lbl]) => <option key={t} value={t}>{lbl}</option>)}
              </select>
              {f.type !== activity.type ? (
                <p className="small" style={{ color: 'var(--warn)' }}>
                  ⚠ Att byta typ rensar aktivitetens frågor/innehåll — det sker när du sparar nedan.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <input type="text" value={typeLabel(activity.type)} disabled />
              <p className="muted small">Låst när aktiviteten öppnats — sätt tillbaka till Utkast för att ändra.</p>
            </>
          )}
        </div>

        <div className="field">
          <label>Regler / info</label>
          <RichTextEditor value={f.description || ''} onChange={set('description')} />
        </div>

        <div className="field">
          <label>Så ser spelarna reglerna (auto, från typ &amp; poängsättning)</label>
          <ul className="muted small" style={{ margin: '.1rem 0 0', paddingLeft: '1.15rem', lineHeight: 1.55 }}>
            {rulesSummary({ ...activity, ...f }).map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>

        <div className="field">
          <label>Bild / karta</label>
          <ImageUploader value={f.imageUrl || ''} onChange={set('imageUrl')} />
        </div>

        {activity.eventId ? (
          <div className="field">
            <label>Bibliotek</label>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn ghost sm" disabled={libBusy} onClick={onAddToLibrary}>
                {libBusy ? 'Sparar…' : '+ Lägg till i biblioteket'}
              </button>
              <span className="muted small">Sparar en återanvändbar kopia. Hantera & dela under <Link to="/library">Bibliotek</Link>.</span>
            </div>
            {dirty ? <p className="muted small" style={{ margin: '4px 0 0' }}>Tips: spara dina ändringar först — kopian tar med det som är sparat.</p> : null}
          </div>
        ) : null}

        {usesQuestions ? (
          <>
            <CheckboxField checked={f.randomizeQuestions} onChange={set('randomizeQuestions')} label="Slumpa frågeordning per spelare" />
            <CheckboxField checked={f.hideQuestionsFromHost} onChange={saveHideQuestions} label="Dölj frågorna för mig — jag spelar också" />
          </>
        ) : null}

        {activity.type === ActivityType.MusicQuiz ? (
          <>
            <CheckboxField checked={f.hitsterMode} onChange={set('hitsterMode')} label="Hitster-läge — lagen bygger tidslinjer" />
            {f.hitsterMode ? (
              <div className="field" style={{ marginLeft: 28 }}>
                <label htmlFor="m-hitster-cards">Antal kort i tidslinjen för att vinna</label>
                <input type="number" id="m-hitster-cards" min={3} max={30} value={f.hitsterCardsToWin} onChange={(e) => set('hitsterCardsToWin')(Number(e.target.value))} style={{ width: 120 }} />
              </div>
            ) : null}
            {!f.hitsterMode ? (
              <>
                <CheckboxField checked={f.musicChoices} onChange={set('musicChoices')} label="Flerval — spelarna trycker på rätt svar" />
                {f.musicChoices ? (
                  <div className="field">
                    <label htmlFor="m-music-choice-mode">Flervalet gäller</label>
                    <select
                      id="m-music-choice-mode"
                      value={f.musicChoiceMode}
                      onChange={(e) => set('musicChoiceMode')(Number(e.target.value))}
                    >
                      <option value={0}>Artist — tryck på rätt artist</option>
                      <option value={1}>Låt — tryck på rätt låttitel</option>
                      <option value={2}>Mix — varje låt frågar slumpvis om artist eller titel</option>
                    </select>
                  </div>
                ) : null}
                <CheckboxField checked={f.speedScoring} onChange={set('speedScoring')} label="Snabbhetspoäng — snabbare svar ger mer poäng" />
              </>
            ) : null}
            {spotifyClientId ? (
              <div className="field">
                <label htmlFor="m-spotify">Autofyllningskälla</label>
                <select id="m-spotify" value={f.spotifyConnectionId ?? '0'} onChange={(e) => set('spotifyConnectionId')(e.target.value)}>
                  <option value="0">Gratis — Spotify oEmbed + MusicBrainz (ingen inloggning)</option>
                  {connections.map((c) => <option key={c.id} value={c.id}>Spotify: {c.name}</option>)}
                </select>
              </div>
            ) : null}
            <CheckboxField checked={f.hideQuestionsFromHost} onChange={saveHideQuestions} label="Dölj svaren för mig — jag spelar också" />
          </>
        ) : null}

        {usesRounds ? (
          <>
            <div className="field">
              <label htmlFor="m-measure">Vad du registrerar</label>
              <select id="m-measure" value={f.measurement} onChange={(e) => onMeasurementChange(Number(e.target.value))}>
                <option value={Measurement.Points}>Poäng / antal</option>
                <option value={Measurement.TimeSeconds}>Tid (mm:ss)</option>
                <option value={Measurement.Millimetres}>Längd (millimeter)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="m-win">Vem vinner</label>
              <select id="m-win" value={f.scoringMode} onChange={(e) => set('scoringMode')(Number(e.target.value))}>
                <option value={ScoringMode.HigherWins}>Högst vinner</option>
                <option value={ScoringMode.LowerWins}>Lägst vinner (t.ex. snabbast)</option>
                <option value={ScoringMode.ClosestToTarget}>Närmast målvärdet vinner</option>
              </select>
            </div>
            {f.scoringMode === ScoringMode.ClosestToTarget ? (
              <div className="field">
                <label htmlFor="m-target">Målvärde {f.measurement === Measurement.TimeSeconds ? '(sekunder — 147 = 2:27)' : ''}</label>
                <input id="m-target" type="number" min={0} max={100000} value={f.targetValue} onChange={(e) => set('targetValue')(Number(e.target.value))} style={{ width: 160 }} />
              </div>
            ) : null}
            {activity.type === ActivityType.ScoreGame ? (
              <>
                <div className="field">
                  <label htmlFor="m-entry">Hur laget spelar</label>
                  <select id="m-entry" value={f.scoreEntryMode} onChange={(e) => set('scoreEntryMode')(Number(e.target.value))}>
                    <option value={ScoreEntryMode.Team}>Hela laget spelar varje runda (ett resultat per runda)</option>
                    <option value={ScoreEntryMode.PerPlayer}>Varje spelare spelar en runda (ett resultat per spelare)</option>
                  </select>
                </div>
                {f.scoreEntryMode === ScoreEntryMode.Team ? (
                  <div className="field">
                    <label htmlFor="m-rounds">Antal rundor</label>
                    <input id="m-rounds" type="number" min={1} max={50} value={f.roundCount} onChange={(e) => set('roundCount')(Number(e.target.value))} style={{ width: 120 }} />
                  </div>
                ) : (
                  <p className="muted small">Varje spelare spelar en runda, så antalet rundor matchar lagstorleken.</p>
                )}
                <div className="field">
                  <label htmlFor="m-ppr">Spelare per runda (valfritt)</label>
                  <input id="m-ppr" type="number" min={1} max={50} value={f.playersPerRound ?? ''} onChange={(e) => set('playersPerRound')(e.target.value === '' ? '' : Number(e.target.value))} style={{ width: 120 }} placeholder="valfritt" />
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {activity.type === ActivityType.MapPin ? (
          <div className="field">
            <label htmlFor="m-cities">Städer att placera</label>
            <input id="m-cities" type="number" min={1} max={20} value={f.mapCityCount} onChange={(e) => set('mapCityCount')(Number(e.target.value))} disabled={!isDraft} style={{ width: 120 }} />
            <p className="muted small">{isDraft ? 'Sätt detta innan du öppnar den.' : 'Uppsättningen är redan dragen — låst.'}</p>
          </div>
        ) : null}

        {activity.type === ActivityType.Boule ? (
          <BouleSettings f={f} set={set} />
        ) : null}

        {!usesMap ? (
          <div className="field">
            <label>Platsgeofence (valfritt)</label>
            <p className="muted small">Sätt en GPS-punkt + radie. Aktiviteten låses upp på spelarens telefon när de kommer innanför radien.</p>
            <LocationPicker
              lat={f.latitude}
              lng={f.longitude}
              radius={f.radiusMeters}
              onChange={({ lat, lng, radius }) => setF((s) => ({ ...s, latitude: lat, longitude: lng, radiusMeters: radius ?? s.radiusMeters }))}
            />
          </div>
        ) : null}

        <button type="button" className="btn block success" onClick={saveDetails} disabled={busy || !f.title.trim()}>Spara detaljer</button>
      </div>

      {/* Courts / lanes */}
      {usesCourts ? (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Banor</h2>
          <div className="field">
            <label htmlFor="m-court-label">Vad de kallas</label>
            <input type="text" id="m-court-label" value={courtLabel} onChange={(e) => setCourtLabel(e.target.value)} maxLength={30} style={{ width: 180 }} />
          </div>
          {courtNames.map((name, i) => (
            <div key={i} className="row">
              <input type="text" className="grow" value={name} maxLength={60} onChange={(e) => setCourtNames((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))} />
              <button type="button" className="btn ghost sm danger" onClick={() => setCourtNames((arr) => arr.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div className="row">
            <button type="button" className="btn ghost sm" onClick={() => setCourtNames((arr) => [...arr, `${(courtLabel || 'Bana').trim()} ${arr.length + 1}`])}>+ Lägg till</button>
            <span className="grow" />
            <button type="button" className="btn success sm" onClick={saveCourts} disabled={busy}>Spara banor</button>
          </div>
        </div>
      ) : null}

      {/* Questions */}
      {usesQuestions ? (
        isDraft ? (
          <>
            {usesMap ? <StationsEditor key={`stations-${qVersion}`} activity={activity} onChanged={onEditorChanged} /> : null}
            <QuestionEditor key={`questions-${qVersion}`} activity={activity} onChanged={onEditorChanged} />
          </>
        ) : (
          <div className="card muted">Frågorna är låsta medan aktiviteten är {activity.status === ActivityStatus.Open ? 'öppen' : activity.status === ActivityStatus.Live ? 'live' : 'avslutad'}. Sätt tillbaka till Utkast för att redigera.</div>
        )
      ) : null}

      {/* Music tracks */}
      {activity.type === ActivityType.MusicQuiz ? (
        isDraft ? (
          <MusicTracksEditor key={`tracks-${qVersion}`} activity={activity} onChanged={onEditorChanged} />
        ) : (
          <div className="card muted">Spåren är låsta tills aktiviteten är ett utkast igen.</div>
        )
      ) : null}

      {/* Memory */}
      {activity.type === ActivityType.Memory ? (
        <>
          <div className="card stack">
            <div className="field">
              <label htmlFor="m-mem">Poängsätts efter</label>
              <select id="m-mem" value={f.measurement} onChange={(e) => saveMemoryMeasurement(Number(e.target.value))}>
                <option value={Measurement.TimeSeconds}>Snabbast tid vinner</option>
                <option value={Measurement.Points}>Färst vändningar vinner</option>
              </select>
            </div>
          </div>
          {isDraft ? (
            <MemoryCardsEditor key={`memory-${qVersion}`} activity={activity} onChanged={onEditorChanged} />
          ) : (
            <div className="card muted">Korten är låsta tills aktiviteten är ett utkast igen.</div>
          )}
        </>
      ) : null}

      {/* Imposture */}
      {activity.type === ActivityType.Imposture ? (
        <>
          <div className="card stack">
            <h2 style={{ margin: 0 }}>Imposture-inställningar</h2>
            <div className="field">
              <label htmlFor="imp-count">Antal impostorer</label>
              <input
                id="imp-count" type="number" min={1} max={5} style={{ width: 100 }}
                value={f.impostorCount}
                onChange={(e) => saveImpostureConfig({ impostorCount: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })}
              />
            </div>
            <label className="row" style={{ gap: '.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox" checked={!!f.revealCategoryToImpostor}
                onChange={(e) => saveImpostureConfig({ revealCategoryToImpostor: e.target.checked })}
              />
              <span>Visa kategorin för impostorn (en liten ledtråd)</span>
            </label>
            <div className="field">
              <label htmlFor="imp-scoring">Poängsystem</label>
              <select
                id="imp-scoring" value={f.impostureScoring}
                onChange={(e) => saveImpostureConfig({ impostureScoring: Number(e.target.value) })}
              >
                <option value={ImpostureScoring.CatchersOnly}>Bara rätt röst ger poäng</option>
                <option value={ImpostureScoring.Standard}>Rätt röst + oavslöjad impostor får poäng</option>
                <option value={ImpostureScoring.StandardPlusGuess}>…plus: avslöjad impostor får gissa ordet för bonus</option>
              </select>
            </div>
          </div>
          {isDraft ? (
            <ImpostureWordsEditor key={`imposture-${qVersion}`} activity={activity} onChanged={onEditorChanged} />
          ) : (
            <div className="card muted">Orden är låsta tills aktiviteten är ett utkast igen.</div>
          )}
        </>
      ) : null}

      <ConfirmDialog
        open={confirm === 'delete'}
        title="Ta bort aktivitet?"
        message="Det här går inte att ångra."
        confirmLabel="Ta bort"
        danger
        onConfirm={remove}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'reset'}
        title="Återställ till utkast?"
        message="Alla poäng nollställs och aktiviteten går tillbaka till utkast."
        confirmLabel="Ja, återställ"
        danger
        onConfirm={resetToDraft}
        onCancel={() => setConfirm(null)}
      />

      {/* Unsaved-changes guard when leaving the editor. */}
      {leaveTo != null ? (
        <div
          role="presentation"
          onClick={() => setLeaveTo(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,15,30,0.5)', zIndex: 400, display: 'grid', placeItems: 'center', padding: 16 }}
        >
          <div className="card stack" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380, width: '100%' }}>
            <h3 style={{ margin: 0 }}>Osparade ändringar</h3>
            <p className="muted" style={{ margin: 0 }}>Du har ändrat något som inte är sparat ännu.</p>
            <button
              type="button"
              className="btn success block"
              disabled={busy}
              onClick={async () => {
                if (!f || !f.title.trim()) { show('Ge aktiviteten ett namn först.'); return; }
                setBusy(true);
                try {
                  await updateActivity(id, buildBody(f));
                  const to = leaveTo;
                  setLeaveTo(null);
                  navigate(to);
                } catch (err) {
                  show(err?.message || 'Kunde inte spara.');
                  setBusy(false);
                }
              }}
            >
              Spara och gå
            </button>
            <button type="button" className="btn ghost block" onClick={() => { const to = leaveTo; setLeaveTo(null); navigate(to); }}>
              Gå utan att spara
            </button>
            <button type="button" className="btn ghost block" onClick={() => setLeaveTo(null)}>Avbryt</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

// Advanced tournament (knockout) settings block.
function BouleSettings({ f, set }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  return (
    <>
      <div className="field">
        <label htmlFor="m-mf">Matchresultat</label>
        <select id="m-mf" value={f.matchFormat} onChange={(e) => set('matchFormat')(Number(e.target.value))}>
          <option value={MatchFormat.Free}>Fri poäng — ett resultat per match, högst vinner</option>
          <option value={MatchFormat.Sets}>Set — bäst av, flest set vinner</option>
        </select>
      </div>
      {f.matchFormat === MatchFormat.Sets ? (
        <div className="row wrap">
          <div className="field" style={{ width: 170 }}>
            <label htmlFor="m-bos">Set per match</label>
            <select id="m-bos" value={f.bestOfSets} onChange={(e) => set('bestOfSets')(Number(e.target.value))}>
              <option value={1}>Enkelt set</option>
              <option value={3}>Bäst av 3</option>
              <option value={5}>Bäst av 5</option>
            </select>
          </div>
          <div className="field" style={{ width: 170 }}>
            <label htmlFor="m-gws">Game för att vinna set</label>
            <input id="m-gws" type="number" min={1} max={100} value={f.gamesToWinSet} onChange={(e) => set('gamesToWinSet')(Number(e.target.value))} />
          </div>
        </div>
      ) : null}

      <button type="button" className="btn ghost sm" onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? '▾' : '▸'} Avancerat — gruppspel, seedning &amp; poäng
      </button>

      {showAdvanced ? (
        <div className="stack card" style={{ background: 'var(--surface-2)' }}>
          <CheckboxField checked={f.useGroupStage} onChange={set('useGroupStage')} label="Spela ett gruppspel först (round-robin, sedan slutspel)" />
          {f.useGroupStage ? (
            <>
              <div className="row wrap">
                <div className="field" style={{ width: 200 }}>
                  <label htmlFor="m-gc">Antal grupper</label>
                  <input id="m-gc" type="number" min={0} max={32} value={f.groupCount} onChange={(e) => set('groupCount')(Number(e.target.value))} />
                  <p className="muted small">0 = föreslå bästa fördelning</p>
                </div>
                <div className="field" style={{ width: 220 }}>
                  <label htmlFor="m-gmf">Gruppmatchresultat</label>
                  <select id="m-gmf" value={f.groupMatchFormat} onChange={(e) => set('groupMatchFormat')(Number(e.target.value))}>
                    <option value={MatchFormat.Free}>Fri poäng (ett resultat)</option>
                    <option value={MatchFormat.Sets}>Set — bäst av</option>
                  </select>
                </div>
              </div>
              {f.groupMatchFormat === MatchFormat.Sets ? (
                <div className="row wrap">
                  <div className="field" style={{ width: 170 }}>
                    <label htmlFor="m-gbos">Set per gruppmatch</label>
                    <select id="m-gbos" value={f.groupBestOfSets} onChange={(e) => set('groupBestOfSets')(Number(e.target.value))}>
                      <option value={1}>Enkelt set</option>
                      <option value={3}>Bäst av 3</option>
                      <option value={5}>Bäst av 5</option>
                    </select>
                  </div>
                  <div className="field" style={{ width: 170 }}>
                    <label htmlFor="m-ggws">Game för att vinna set</label>
                    <input id="m-ggws" type="number" min={1} max={100} value={f.groupGamesToWinSet} onChange={(e) => set('groupGamesToWinSet')(Number(e.target.value))} />
                  </div>
                </div>
              ) : null}
              <div className="row wrap">
                <div className="field" style={{ width: 200 }}>
                  <label htmlFor="m-aa">Avancera till slutspel A / grupp</label>
                  <input id="m-aa" type="number" min={1} max={16} value={f.advanceToPlayoffA} onChange={(e) => set('advanceToPlayoffA')(Number(e.target.value))} />
                </div>
                <div className="field" style={{ width: 200 }}>
                  <label htmlFor="m-ab">Avancera till slutspel B / grupp</label>
                  <input id="m-ab" type="number" min={0} max={16} value={f.advanceToPlayoffB} onChange={(e) => set('advanceToPlayoffB')(Number(e.target.value))} />
                  <p className="muted small">0 = inget slutspel B</p>
                </div>
              </div>
            </>
          ) : null}
          <CheckboxField checked={f.playoffAConsolation} onChange={set('playoffAConsolation')} label={`${f.useGroupStage ? 'Slutspel A' : 'Slutspelet'} har en förlorarsida`} />
          {f.useGroupStage && f.advanceToPlayoffB > 0 ? (
            <CheckboxField checked={f.playoffBConsolation} onChange={set('playoffBConsolation')} label="Slutspel B har en förlorarsida" />
          ) : null}
          <CheckboxField checked={f.useManualSeeding} onChange={set('useManualSeeding')} label="Seeda lagen manuellt (rang 1→N)" />
          <div className="field">
            <label htmlFor="m-ts">Hur resultat matar tabellen</label>
            <select id="m-ts" value={f.tournamentScoring} onChange={(e) => set('tournamentScoring')(Number(e.target.value))}>
              <option value={TournamentScoring.PerWin}>Poäng per vinst (grupp 1, slutspel A 3, B 2; tröst 1)</option>
              <option value={TournamentScoring.Placement}>Slutplacering (rangordna efter hur långt varje lag nådde)</option>
            </select>
          </div>
        </div>
      ) : null}
    </>
  );
}

function CheckboxField({ checked, onChange, label }) {
  return (
    <div className="field">
      <label className="row" style={{ fontWeight: 500 }}>
        <input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
    </div>
  );
}

// Copy an ActivityDto into the flat edit-field shape.
function fieldsFrom(a) {
  return {
    type: a.type,
    title: a.title || '',
    description: a.description ?? '',
    imageUrl: a.imageUrl ?? '',
    scoreEntryMode: a.scoreEntryMode ?? ScoreEntryMode.Team,
    roundCount: a.roundCount ?? 1,
    playersPerRound: a.playersPerRound ?? '',
    scoringMode: a.scoringMode ?? ScoringMode.HigherWins,
    measurement: a.measurement ?? Measurement.Points,
    targetValue: a.targetValue ?? 147,
    matchFormat: a.matchFormat ?? MatchFormat.Free,
    bestOfSets: a.bestOfSets ?? 3,
    gamesToWinSet: a.gamesToWinSet ?? 13,
    useGroupStage: !!a.useGroupStage,
    groupCount: a.groupCount ?? 0,
    groupMatchFormat: a.groupMatchFormat ?? MatchFormat.Free,
    groupBestOfSets: a.groupBestOfSets ?? 1,
    groupGamesToWinSet: a.groupGamesToWinSet ?? 13,
    advanceToPlayoffA: a.advanceToPlayoffA ?? 2,
    advanceToPlayoffB: a.advanceToPlayoffB ?? 0,
    playoffAConsolation: a.playoffAConsolation ?? true,
    playoffBConsolation: !!a.playoffBConsolation,
    useManualSeeding: !!a.useManualSeeding,
    tournamentScoring: a.tournamentScoring ?? TournamentScoring.PerWin,
    mapCityCount: a.mapCityCount ?? 5,
    randomizeQuestions: !!a.randomizeQuestions,
    musicChoices: !!a.musicChoices,
    musicChoiceMode: a.musicChoiceMode ?? 0,
    speedScoring: !!a.speedScoring,
    hitsterMode: !!a.hitsterMode,
    hitsterCardsToWin: a.hitsterCardsToWin ?? 10,
    spotifyConnectionId: a.spotifyConnectionId ?? '0',
    hideQuestionsFromHost: !!a.hideQuestionsFromHost,
    impostorCount: a.impostorCount ?? 1,
    revealCategoryToImpostor: a.revealCategoryToImpostor !== false,
    impostureScoring: a.impostureScoring ?? ImpostureScoring.Standard,
    isPublic: !!a.isPublic,
    latitude: a.latitude ?? null,
    longitude: a.longitude ?? null,
    radiusMeters: a.radiusMeters ?? 40,
  };
}

// Build the full UpdateActivityRequest body from the flat edit fields. Sent for
// every save (including Memory's immediate measurement save) so no field is
// inadvertently reset to its server default by being absent.
function buildBody(f) {
  return {
    type: f.type,
    title: f.title.trim(),
    description: f.description,
    imageUrl: f.imageUrl,
    scoringMode: f.scoringMode,
    measurement: f.measurement,
    targetValue: f.targetValue,
    randomizeQuestions: f.randomizeQuestions,
    musicChoices: f.musicChoices,
    musicChoiceMode: f.musicChoiceMode,
    speedScoring: f.speedScoring,
    hitsterMode: f.hitsterMode,
    hitsterCardsToWin: f.hitsterCardsToWin,
    spotifyConnectionId: f.spotifyConnectionId === '0' || f.spotifyConnectionId === 0 ? null : f.spotifyConnectionId,
    hideQuestionsFromHost: f.hideQuestionsFromHost,
    impostorCount: f.impostorCount,
    revealCategoryToImpostor: f.revealCategoryToImpostor,
    impostureScoring: f.impostureScoring,
    isPublic: f.isPublic,
    scoreEntryMode: f.scoreEntryMode,
    roundCount: f.roundCount,
    playersPerRound: f.playersPerRound === '' ? null : f.playersPerRound,
    latitude: f.latitude,
    longitude: f.longitude,
    radiusMeters: f.latitude != null ? f.radiusMeters : null,
    matchFormat: f.matchFormat,
    bestOfSets: f.bestOfSets,
    gamesToWinSet: f.gamesToWinSet,
    useGroupStage: f.useGroupStage,
    groupCount: f.groupCount,
    groupMatchFormat: f.groupMatchFormat,
    groupBestOfSets: f.groupBestOfSets,
    groupGamesToWinSet: f.groupGamesToWinSet,
    advanceToPlayoffA: f.advanceToPlayoffA,
    advanceToPlayoffB: f.advanceToPlayoffB,
    playoffAConsolation: f.playoffAConsolation,
    playoffBConsolation: f.playoffBConsolation,
    useManualSeeding: f.useManualSeeding,
    tournamentScoring: f.tournamentScoring,
    mapCityCount: f.mapCityCount,
  };
}
