// CreateEvent — "/create" — a guided, one-page setup so a host can put together
// a whole game day in a minute: name it → tap games to add them → one-tap fill
// quiz questions from the library → share the code. Deep per-game authoring
// still lives on /manage/:id (the "Redigera" link), but you reach "playable"
// without leaving this page. Host-only (route wrapped in ProtectedRoute).
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { createEvent, getEvent } from '../api/events';
import { createActivity } from '../api/activities';
import { generateFromLibrary } from '../api/library';
import { ActivityType } from '../config/enums';
import { useToast } from '../components/Toast';
import QrShareModal from '../components/QrShareModal';
import { useDocumentTitle } from '../utils/useDocumentTitle';

// Each game card: how it plays + what (if anything) it still needs after adding.
// quickFill = can be filled with library questions in one tap. manageHint = the
// thing you finish on the editor page (null ⇒ ready to play as soon as it's added).
const GAMES = [
  { type: ActivityType.Quiz, emoji: '❓', name: 'Quiz', desc: 'Frågor i tur och ordning', quickFill: true, manageHint: null },
  { type: ActivityType.Tipspromenad, emoji: '🚶', name: 'Tipspromenad', desc: 'Frågor utplacerade på en karta', quickFill: true, manageHint: 'placera frågorna på kartan' },
  { type: ActivityType.MusicQuiz, emoji: '🎵', name: 'Musikquiz', desc: 'Gissa låt och artist', quickFill: false, manageHint: 'lägg till spår' },
  { type: ActivityType.Memory, emoji: '🃏', name: 'Memory', desc: 'Hitta paren snabbast', quickFill: false, manageHint: 'lägg till kort' },
  { type: ActivityType.Boule, emoji: '🏆', name: 'Turnering', desc: 'Utslagsspel (boule m.m.)', quickFill: false, manageHint: null },
  { type: ActivityType.ScoreGame, emoji: '🔢', name: 'Poängspel', desc: 'Registrera poäng per runda', quickFill: false, manageHint: null },
  { type: ActivityType.WordGame, emoji: '🔤', name: 'Ordspel', desc: 'Bygg det längsta ordet', quickFill: false, manageHint: null },
  { type: ActivityType.MapPin, emoji: '📍', name: 'Kartnål', desc: 'Pricka in städer på kartan', quickFill: false, manageHint: null },
  { type: ActivityType.Imposture, emoji: '🕵️', name: 'Imposture', desc: 'Hitta den hemliga impostorn', quickFill: false, manageHint: 'lägg till hemliga ord' },
];
const gameOf = (type) => GAMES.find((g) => g.type === type);
const TEAM_SIZES = [
  { size: 1, label: 'En och en' },
  { size: 2, label: 'Lag om 2' },
  { size: 3, label: 'Lag om 3' },
  { size: 4, label: 'Lag om 4' },
];

export default function CreateEvent() {
  useDocumentTitle('Skapa evenemang · GameDo');
  const navigate = useNavigate();
  const { eventId } = useParams();
  const { toast, show } = useToast();

  const [name, setName] = useState('');
  const [teamSize, setTeamSize] = useState(1);
  const [busy, setBusy] = useState(false);
  const [event, setEvent] = useState(null); // the created event (phase B)
  const [games, setGames] = useState([]); // [{ id, title, type, questionCount }]
  const [shareOpen, setShareOpen] = useState(false);
  const [loading, setLoading] = useState(!!eventId);

  // Resume an in-progress setup keyed by event id: load the event + its games so
  // you can come back here (e.g. after editing a game) and keep adding.
  useEffect(() => {
    if (!eventId) { setEvent(null); setGames([]); setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const ev = await getEvent(eventId);
        if (!alive) return;
        setEvent(ev);
        setGames(
          (ev.activities || []).slice().sort((a, b) => a.order - b.order)
            .map((a) => ({ id: a.id, title: a.title, type: a.type, questionCount: a.questionCount || 0 }))
        );
      } catch (e) {
        if (alive) show(e?.message || 'Kunde inte ladda evenemanget.');
      } finally {
        if (alive) { setLoading(false); setBusy(false); }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  const shareUrl = event ? `${window.location.origin}/e/${event.id}` : '';

  const createTheEvent = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const ev = await createEvent({ name: name.trim(), teamSize });
      navigate(`/create/${ev.id}`); // → phase B (resumable by id)
    } catch (e) {
      show(e?.message || 'Kunde inte skapa evenemanget.');
      setBusy(false);
    }
  };

  const addGame = async (g) => {
    if (busy || !event) return;
    setBusy(true);
    try {
      // Auto-number duplicate types so two quizzes don't both read "Quiz".
      const sameType = games.filter((x) => x.type === g.type).length;
      const title = sameType === 0 ? g.name : `${g.name} ${sameType + 1}`;
      const a = await createActivity({ type: g.type, title, eventId: event.id });
      setGames((list) => [...list, { id: a.id, title: a.title, type: a.type, questionCount: 0 }]);
    } catch (e) {
      show(e?.message || 'Kunde inte lägga till spelet.');
    } finally {
      setBusy(false);
    }
  };

  const quickFill = async (gameId) => {
    setBusy(true);
    try {
      const r = await generateFromLibrary(gameId, 5, []);
      const added = r?.added ?? 0;
      setGames((list) => list.map((x) => (x.id === gameId ? { ...x, questionCount: x.questionCount + added } : x)));
      show(added ? `La till ${added} frågor.` : 'Inga fler frågor i biblioteket.');
    } catch (e) {
      show(e?.message || 'Kunde inte hämta frågor.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (<>{toast}<div className="loading-page"><span className="spinner" /></div></>);
  }

  // ── Phase A: name the event ────────────────────────────────────────────────
  if (!event) {
    return (
      <>
        {toast}
        <div className="card stack center">
          <img src="/assets/gamedo-mark.svg" width={52} height={52} alt="" style={{ margin: '0 auto' }} />
          <h1 style={{ margin: 0 }}>Skapa ett evenemang</h1>
          <p className="muted" style={{ margin: 0 }}>Ge dagen ett namn, så bygger vi spelen i nästa steg.</p>
        </div>

        <div className="card stack">
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="ev-name">Vad heter dagen?</label>
            <input
              type="text"
              id="ev-name"
              value={name}
              maxLength={80}
              autoFocus
              placeholder="t.ex. Försommarspelen 2026"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createTheEvent(); }}
            />
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <label style={{ margin: 0 }}>Hur spelar ni?</label>
            <div className="row wrap" style={{ gap: 8 }}>
              {TEAM_SIZES.map((t) => (
                <button
                  key={t.size}
                  type="button"
                  className={`btn sm ${teamSize === t.size ? '' : 'ghost'}`}
                  onClick={() => setTeamSize(t.size)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <span className="muted small">Du kan ändra det här senare.</span>
          </div>

          <button type="button" className="btn block lg success" onClick={createTheEvent} disabled={busy || !name.trim()}>
            {busy ? 'Skapar…' : 'Skapa & lägg till spel →'}
          </button>
        </div>
      </>
    );
  }

  // ── Phase B: add games + share ──────────────────────────────────────────────
  const ready = games.length > 0;
  return (
    <>
      {toast}
      <div className="card stack">
        <div className="spread">
          <div>
            <h1 style={{ margin: 0 }}>{event.name}</h1>
            <span className="muted small">Kod <b style={{ letterSpacing: '0.08em' }}>{event.joinCode}</b></span>
          </div>
          <button type="button" className="btn ghost sm" onClick={() => setShareOpen(true)}>Dela</button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>Tryck på ett spel för att lägga till det. Lägg till så många du vill.</p>
      </div>

      {/* Game picker grid */}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Lägg till spel</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
          {GAMES.map((g) => (
            <button
              key={g.type}
              type="button"
              onClick={() => addGame(g)}
              disabled={busy}
              className="card"
              style={{ textAlign: 'left', cursor: 'pointer', padding: 12, display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid var(--border)' }}
            >
              <span style={{ fontSize: '1.6rem' }}>{g.emoji}</span>
              <b>{g.name}</b>
              <span className="muted small">{g.desc}</span>
              <span className="pill accent" style={{ marginTop: 4, alignSelf: 'flex-start' }}>+ Lägg till</span>
            </button>
          ))}
        </div>
      </div>

      {/* Added games */}
      {ready ? (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Dina spel ({games.length})</h2>
          {games.map((x, i) => {
            const g = gameOf(x.type);
            const filled = x.questionCount > 0;
            return (
              <div key={x.id} className="card stack" style={{ background: 'var(--surface-2)', gap: 8 }}>
                <div className="spread">
                  <b>{i + 1}. {x.title}</b>
                  <span>{g?.emoji}</span>
                </div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {filled ? <span className="pill ok">✓ {x.questionCount} frågor</span> : null}
                  {!filled && g?.manageHint ? <span className="pill warn">Behöver: {g.manageHint}</span> : null}
                  {!filled && !g?.manageHint && !g?.quickFill ? <span className="pill ok">✓ Klar att spela</span> : null}
                </div>
                <div className="row wrap" style={{ gap: 8 }}>
                  {g?.quickFill ? (
                    <button type="button" className="btn sm" onClick={() => quickFill(x.id)} disabled={busy}>
                      + 5 frågor från biblioteket
                    </button>
                  ) : null}
                  <button type="button" className="btn ghost sm" onClick={() => navigate(`/manage/${x.id}`, { state: { returnTo: `/create/${event.id}` } })}>
                    Redigera
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card center muted">Inga spel ännu — välj något ovan.</div>
      )}

      {/* Done */}
      <div className="card stack">
        <button type="button" className="btn block lg success" onClick={() => navigate(`/e/${event.id}`)} disabled={!ready}>
          {ready ? 'Klar — öppna evenemanget →' : 'Lägg till minst ett spel'}
        </button>
        <p className="muted small center" style={{ margin: 0 }}>
          På evenemangssidan startar du spelen, bjuder in vänner och följer resultattavlan.
        </p>
      </div>

      <QrShareModal
        open={shareOpen}
        url={shareUrl}
        title={`Gå med i ${event.name} — kod ${event.joinCode}`}
        onClose={() => setShareOpen(false)}
      />
    </>
  );
}
