// MusicTracksEditor — author the track list for a MusicQuiz. The React port of
// rundan's MusicTracksEditor.razor. Each track is a FreeText question whose text is
// "Track N", carrying a Spotify link + correct song (acceptedFreeTextAnswer) +
// artist (acceptedArtist) + optional releaseYear (Hitster-style round) + points.
// Supports per-track and bulk auto-fill from a link (lookupTrack) and bulk import
// from a playlist (importPlaylist).
//
// IMPORTANT load semantics: load ONCE per activity with reveal:true (the real
// answers), then edit rows in place — never re-fetch on prop changes, which would
// clobber unsaved edits. The "hide answers from host" toggle blanks the *fields* in
// the UI (not the data), so a save never wipes them.
//
// Props:
//   activity  : ActivityDto — reads { id, hideQuestionsFromHost }. The musicChoices /
//               speedScoring / hide toggles live in Manage's settings form; this
//               editor owns the track content only.
//   onChanged : () => void — called after add/import/delete so the parent can refresh.
import { useEffect, useRef, useState } from 'react';
import {
  getAdminQuestions, createQuestion, updateQuestion, deleteQuestion,
} from '../api/questions';
import { lookupTrack, importPlaylist } from '../api/music';
import { useAuth } from '../contexts/AuthContext';
import { QuestionKind } from '../config/enums';
import Spinner from './Spinner';

export default function MusicTracksEditor({ activity, onChanged }) {
  // Per-user Spotify: "configured" means the logged-in host has their own Client ID.
  const { user } = useAuth();
  const spotifyConfigured = !!user?.spotifyClientId;
  const hideFromHost = !!activity?.hideQuestionsFromHost;

  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fillingId, setFillingId] = useState(null);
  const [fillingAll, setFillingAll] = useState(false);
  const [fillAllNote, setFillAllNote] = useState(null);
  const [fillNotes, setFillNotes] = useState({}); // { [id]: string }

  const [importUrl, setImportUrl] = useState('');
  const [importCount, setImportCount] = useState(10);
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Load once per activity, revealing the real answers.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const list = await getAdminQuestions(activity.id, true);
        if (alive) setTracks(list || []);
      } catch (e) {
        if (alive) setError(e?.message || 'Kunde inte ladda spåren.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [activity.id]);

  // Immutable in-place patch of one track row.
  const patch = (id, fields) => setTracks((arr) => arr.map((t) => (t.id === id ? { ...t, ...fields } : t)));

  const buildBody = (t) => ({
    order: t.order,
    text: (t.text && t.text.trim()) ? t.text : `Track ${t.order}`,
    kind: QuestionKind.FreeText,
    points: Math.max(0, Number(t.points) || 0),
    spotifyUrl: t.spotifyUrl || null,
    acceptedFreeTextAnswer: t.acceptedFreeTextAnswer || null,
    acceptedArtist: t.acceptedArtist || null,
    releaseYear: t.releaseYear != null && t.releaseYear !== '' ? Number(t.releaseYear) : null,
  });

  async function persist(t) {
    return updateQuestion(activity.id, t.id, buildBody(t));
  }

  async function addTrack() {
    setBusy(true);
    setError(null);
    try {
      const order = tracks.length === 0 ? 1 : Math.max(...tracks.map((t) => t.order)) + 1;
      const created = await createQuestion(activity.id, {
        order,
        text: `Track ${order}`,
        kind: QuestionKind.FreeText,
        points: 1,
      });
      if (aliveRef.current && created) setTracks((arr) => [...arr, created]); // append locally
      onChanged?.();
    } catch (e) {
      setError(e?.message || 'Kunde inte lägga till spåret.');
    } finally {
      setBusy(false);
    }
  }

  async function saveTrack(t) {
    setBusy(true);
    setError(null);
    try {
      await persist(t);
    } catch (e) {
      setError(e?.message || 'Kunde inte spara spåret.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteTrack(t) {
    setBusy(true);
    setError(null);
    try {
      await deleteQuestion(activity.id, t.id);
      if (aliveRef.current) setTracks((arr) => arr.filter((x) => x.id !== t.id));
      onChanged?.();
    } catch (e) {
      setError(e?.message || 'Kunde inte ta bort spåret.');
    } finally {
      setBusy(false);
    }
  }

  // Auto-fill ONE track — only blank fields, never clobber what the host typed.
  async function autoFill(t) {
    if (!t.spotifyUrl || !t.spotifyUrl.trim()) return;
    setFillingId(t.id);
    setFillNotes((m) => { const n = { ...m }; delete n[t.id]; return n; });
    setError(null);
    try {
      const found = await lookupTrack(activity.id, t.spotifyUrl);
      const added = [];
      const fields = {};
      if (found?.title && !(t.acceptedFreeTextAnswer && t.acceptedFreeTextAnswer.trim())) { fields.acceptedFreeTextAnswer = found.title; added.push('låt'); }
      if (found?.artist && !(t.acceptedArtist && t.acceptedArtist.trim())) { fields.acceptedArtist = found.artist; added.push('artist'); }
      if (found?.year != null && (t.releaseYear == null || t.releaseYear === '')) { fields.releaseYear = found.year; added.push('år'); }
      if (Object.keys(fields).length) patch(t.id, fields);
      const note = added.length > 0
        ? `Fyllde i ${added.join(', ')} — kontrollera och tryck Spara.`
        : found?.found ? 'Hittade den, men fälten var redan ifyllda.' : 'Kunde inte hitta den — skriv in svaren själv.';
      setFillNotes((m) => ({ ...m, [t.id]: note }));
    } catch (e) {
      setError(e?.message || 'Uppslagningen misslyckades.');
    } finally {
      setFillingId(null);
    }
  }

  // Auto-fill ALL tracks that have a link, saving each changed one as it goes.
  // Sequential (not Promise.all) so saves are progressive and a failed lookup just
  // skips that track.
  async function autoFillAll() {
    setBusy(true);
    setFillingAll(true);
    setError(null);
    setFillAllNote(null);
    setFillNotes({});
    let filled = 0;
    try {
      // Snapshot ids + read latest from a ref-like local copy as we mutate.
      const targets = tracks.filter((t) => t.spotifyUrl && t.spotifyUrl.trim());
      // Work against a mutable working copy so each iteration sees prior fills.
      const work = tracks.map((t) => ({ ...t }));
      for (const target of targets) {
        const t = work.find((w) => w.id === target.id);
        try {
          // eslint-disable-next-line no-await-in-loop
          const found = await lookupTrack(activity.id, t.spotifyUrl);
          let changed = false;
          if (found?.title && !(t.acceptedFreeTextAnswer && t.acceptedFreeTextAnswer.trim())) { t.acceptedFreeTextAnswer = found.title; changed = true; }
          if (found?.artist && !(t.acceptedArtist && t.acceptedArtist.trim())) { t.acceptedArtist = found.artist; changed = true; }
          if (found?.year != null && (t.releaseYear == null || t.releaseYear === '')) { t.releaseYear = found.year; changed = true; }
          if (changed) {
            // eslint-disable-next-line no-await-in-loop
            await persist(t);
            filled += 1;
            if (aliveRef.current) patch(t.id, { acceptedFreeTextAnswer: t.acceptedFreeTextAnswer, acceptedArtist: t.acceptedArtist, releaseYear: t.releaseYear });
          }
        } catch {
          /* skip this track, keep going */
        }
      }
      setFillAllNote(filled > 0
        ? `Autofyllde ${filled} spår.`
        : 'Inget att fylla — alla spår hade redan sina uppgifter.');
    } finally {
      setFillingAll(false);
      setBusy(false);
    }
  }

  async function runImport() {
    if (!importUrl.trim()) return;
    setImporting(true);
    setImportNote(null);
    setError(null);
    try {
      const result = await importPlaylist(activity.id, importUrl.trim(), importCount);
      const list = await getAdminQuestions(activity.id, true);
      if (aliveRef.current) {
        setTracks(list || []);
        setImportNote((result?.imported || 0) > 0
          ? `La till ${result.imported} spår — kontrollera svaren nedan och spara de du justerar.`
          : 'Inget lades till.');
        setImportUrl('');
      }
      onChanged?.();
    } catch (e) {
      setError(e?.message || 'Importen misslyckades.');
    } finally {
      setImporting(false);
    }
  }

  if (loading) {
    return <div className="card center muted"><Spinner /></div>;
  }

  const anyHasLink = tracks.some((t) => t.spotifyUrl && t.spotifyUrl.trim());

  return (
    <div className="card stack">
      <div className="row">
        <h3 className="grow" style={{ margin: 0 }}>Spår</h3>
        {!hideFromHost && anyHasLink ? (
          <button type="button" className="btn ghost sm" onClick={autoFillAll} disabled={busy} title="Slå upp titel, artist och år för varje spår från dess länk">
            {fillingAll ? 'Fyller…' : 'Autofyll alla'}
          </button>
        ) : null}
        <button type="button" className="btn sm" onClick={addTrack} disabled={busy}>Lägg till ett spår</button>
      </div>

      {fillAllNote ? <p className="muted small" style={{ margin: 0 }}>{fillAllNote}</p> : null}

      <p className="muted small" style={{ margin: 0 }}>
        Klistra in en Spotify-spårlänk (du spelar den), sedan rätt låt och artist. Spelarna skriver båda; varje rätt gissning ger spårets poäng. Lägg till ett <b>utgivningsår</b> för en Hitster-runda — då gissar spelarna även året (exakt = full poäng, inom 2 år = halv). Spelarna ser aldrig länken eller svaren.
      </p>

      {spotifyConfigured ? (
        <div className="card stack" style={{ background: 'var(--accent-soft, #faf7f2)' }}>
          <b>Importera från en Spotify-spellista</b>
          <p className="muted small" style={{ margin: 0 }}>
            Klistra in en spellistelänk och välj hur många spår som ska läggas till. Vi tar ett slumpat urval och autofyller varje spårs titel, artist och utgivningsår — sedan kan du putsa dem nedan.
          </p>
          <p className="muted small" style={{ margin: 0 }}>
            Fungerar med dina egna spellistor (publika eller privata) och andras publika eller delade. Spotifys egna redaktionella spellistor (de med <code>37i9…</code>) kan inte läsas. Om en privat spellista inte laddas, sätt quizets autofyllningskälla till Spotify-kontot som äger den.
          </p>
          <div className="row wrap" style={{ gap: '.4rem', alignItems: 'flex-end' }}>
            <div className="field grow" style={{ margin: 0, minWidth: 220 }}>
              <label className="muted small">Spellistelänk</label>
              <input type="text" placeholder="https://open.spotify.com/playlist/…" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label className="muted small">Hur många</label>
              <input type="number" min={1} max={50} style={{ width: 90 }} value={importCount} onChange={(e) => setImportCount(Number(e.target.value))} />
            </div>
            <button type="button" className="btn sm" onClick={runImport} disabled={busy || importing || !importUrl.trim()}>
              {importing ? 'Importerar…' : 'Importera'}
            </button>
          </div>
          {importNote ? <p className="muted small" style={{ margin: 0 }}>{importNote}</p> : null}
        </div>
      ) : null}

      {error ? <div className="error-text">{error}</div> : null}

      {tracks.length === 0 ? <p className="muted">Inga spår än — lägg till det första.</p> : null}

      {tracks.map((t, i) => (
        <div className="card stack" key={t.id} style={{ background: 'var(--accent-soft, #faf7f2)' }}>
          <div className="row">
            <b className="grow">Spår {i + 1}</b>
            {t.spotifyUrl && t.spotifyUrl.trim() ? (
              <a className="btn ghost sm" href={t.spotifyUrl} target="_blank" rel="noopener noreferrer">▶ Öppna</a>
            ) : null}
            <button type="button" className="btn ghost sm danger" onClick={() => deleteTrack(t)} disabled={busy}>Ta bort</button>
          </div>

          {hideFromHost ? (
            <>
              <input type="text" className="grow" placeholder="Spotify-spårlänk (https://open.spotify.com/track/…)" value={t.spotifyUrl || ''} onChange={(e) => patch(t.id, { spotifyUrl: e.target.value })} />
              <p className="muted small" style={{ margin: 0 }}>
                Svaren är dolda medan du spelar. Stäng av ”Dölj svaren för mig — jag spelar också” för att se eller ändra dem.
              </p>
              <div className="field" style={{ margin: 0 }}>
                <label className="muted small">Poäng per styck</label>
                <input type="number" min={0} max={100} style={{ width: 140 }} value={t.points ?? 0} onChange={(e) => patch(t.id, { points: Number(e.target.value) })} />
              </div>
              <button type="button" className="btn sm success" onClick={() => saveTrack(t)} disabled={busy}>Spara</button>
            </>
          ) : (
            <>
              <div className="row" style={{ gap: '.4rem' }}>
                <input type="text" className="grow" placeholder="Spotify-spårlänk (https://open.spotify.com/track/…)" value={t.spotifyUrl || ''} onChange={(e) => patch(t.id, { spotifyUrl: e.target.value })} />
                <button type="button" className="btn ghost sm" onClick={() => autoFill(t)} disabled={busy || !(t.spotifyUrl && t.spotifyUrl.trim())} title="Slå upp titel/artist/år från länken">
                  {fillingId === t.id ? '…' : 'Autofyll'}
                </button>
              </div>
              {fillNotes[t.id] ? <p className="muted small" style={{ margin: 0 }}>{fillNotes[t.id]}</p> : null}
              <div className="field" style={{ margin: 0 }}>
                <label className="muted small">Låttitel (rätt svar)</label>
                <input type="text" placeholder="t.ex. Bohemian Rhapsody" value={t.acceptedFreeTextAnswer || ''} onChange={(e) => patch(t.id, { acceptedFreeTextAnswer: e.target.value })} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label className="muted small">Artist (rätt svar)</label>
                <input type="text" placeholder="t.ex. Queen" value={t.acceptedArtist || ''} onChange={(e) => patch(t.id, { acceptedArtist: e.target.value })} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label className="muted small">Utgivningsår <span style={{ fontWeight: 400 }}>(valfritt — för en Hitster-runda)</span></label>
                <input type="number" min={1860} max={2100} placeholder="t.ex. 1985" style={{ width: 140 }} value={t.releaseYear ?? ''} onChange={(e) => patch(t.id, { releaseYear: e.target.value === '' ? null : Number(e.target.value) })} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label className="muted small">Poäng per styck</label>
                <input type="number" min={0} max={100} style={{ width: 140 }} value={t.points ?? 0} onChange={(e) => patch(t.id, { points: Number(e.target.value) })} />
              </div>
              <button type="button" className="btn sm success" onClick={() => saveTrack(t)} disabled={busy}>Spara</button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
