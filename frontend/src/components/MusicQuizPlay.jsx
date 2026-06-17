// MusicQuizPlay — host-paced track quiz. The host plays one Spotify track at a
// time; a track reveals to players only when the host starts it (via the
// MusicTrackStarted socket cue, with a 3 s polling backstop). Players name the
// song + artist (+ year when asked) OR tap the artist (Kahoot mode). A countdown
// runs when the activity uses speed/Kahoot scoring.
//
// The React port of rundan's MusicQuizPlay.razor.
//
// Props:
//   activity   : ActivityDto — { id, speedScoring, musicChoices, ... }.
//   participant: ParticipantDto.
//
// MusicTrackStarted payload: { activityId, questionId, startedUtc, windowSeconds }
// AnswerResultDto (music): { songCorrect, artistCorrect, correctSong, correctArtist,
//   correctYear, yearPoints, isCorrect, awardedPoints, answeredCount, totalQuestions }
import { useEffect, useRef, useState } from 'react';
import { getQuestions } from '../api/questions';
import { submitAnswer, getMyAnswers } from '../api/gameplay';
import { getSocket } from '../utils/socket';
import { ServerEvents } from '../config/socketEvents';
import Spinner from './Spinner';
import { OptionButton, OptionKey, optionColor, feedbackStyle } from './QuizPlay';

const DEFAULT_WINDOW = 30; // seconds, when only StartedUtc is known.
const POLL_MS = 3000;
const TICK_MS = 500;

const isChoice = (q) => (q.options?.length || 0) > 0; // server attaches options only for Kahoot
const hasLabel = (q, i) => q.text && q.text.trim() && q.text !== `Track ${i + 1}`;
const shown = (s) => (s && s.trim() ? s : '—');

export default function MusicQuizPlay({ activity, participant }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [answered, setAnswered] = useState(() => new Map()); // qid → MyAnswerDto
  const [results, setResults] = useState(() => new Map()); // qid → AnswerResultDto
  const [live, setLive] = useState(() => new Map()); // qid → { start: Date, window: number }
  const [song, setSong] = useState(() => new Map());
  const [artist, setArtist] = useState(() => new Map());
  const [year, setYear] = useState(() => new Map());
  const [busy, setBusy] = useState(false);
  const [, forceTick] = useState(0); // re-render the countdown

  const disposed = useRef(false);
  const tickerRef = useRef(null);
  const pollRef = useRef(null);
  const pollingRef = useRef(false);
  const tracksRef = useRef([]);
  const liveRef = useRef(new Map());
  const answeredRef = useRef(new Map());

  tracksRef.current = tracks;
  liveRef.current = live;
  answeredRef.current = answered;

  const revealedCount = () =>
    tracksRef.current.filter((q) => answeredRef.current.has(String(q.id)) || liveRef.current.has(String(q.id))).length;

  // ── Initial load ─────────────────────────────────────────────────────────────
  useEffect(() => {
    disposed.current = false;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const qs = await getQuestions(activity.id);
        const mine = await getMyAnswers(activity.id);
        if (!alive) return;
        const ans = new Map(mine.map((a) => [String(a.questionId), a]));
        // Tracks the host already started before we loaded — seed their countdown.
        const lv = new Map();
        for (const q of qs) {
          if (q.startedUtc) lv.set(String(q.id), { start: new Date(q.startedUtc), window: DEFAULT_WINDOW });
        }
        setTracks(qs);
        setAnswered(ans);
        setLive(lv);
        tracksRef.current = qs;
        liveRef.current = lv;
        answeredRef.current = ans;
        if (lv.size > 0) ensureTicking();
        if (revealedCount() < qs.length) ensurePolling();
      } catch (e) {
        if (alive) setError(e?.message || 'Kunde inte ladda låtarna.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      disposed.current = true;
      if (tickerRef.current) clearInterval(tickerRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
      tickerRef.current = null;
      pollRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id]);

  // ── Socket: the host's live "track started" cue ───────────────────────────────
  useEffect(() => {
    let socket = null;
    let alive = true;
    const onStarted = (t) => {
      if (disposed.current || !t || String(t.activityId) !== String(activity.id)) return;
      setLive((prev) => {
        const next = new Map(prev);
        next.set(String(t.questionId), {
          start: new Date(t.startedUtc),
          window: t.windowSeconds || DEFAULT_WINDOW,
        });
        liveRef.current = next;
        return next;
      });
      ensureTicking();
    };
    getSocket().then((s) => {
      if (!alive) return;
      socket = s;
      s.on(ServerEvents.MusicTrackStarted, onStarted);
    });
    return () => {
      alive = false;
      if (socket) socket.off(ServerEvents.MusicTrackStarted, onStarted);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id]);

  // Re-render a few times a second while a track is live; stop when none are.
  function ensureTicking() {
    if (tickerRef.current) return;
    tickerRef.current = setInterval(() => {
      if (disposed.current) return;
      const anyLive = tracksRef.current.some((q) => liveRemaining(q, liveRef.current) != null);
      if (!anyLive) {
        clearInterval(tickerRef.current);
        tickerRef.current = null;
      }
      forceTick((n) => n + 1);
    }, TICK_MS);
  }

  // Poll for tracks the host started (in case a live cue was missed/blocked) and
  // for options that appear if the host turns Kahoot on after load. Stops once
  // every track is revealed.
  function ensurePolling() {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      if (disposed.current || pollingRef.current) return;
      pollingRef.current = true;
      try {
        const fresh = await getQuestions(activity.id);
        if (disposed.current) return;
        let changed = false;
        const nextLive = new Map(liveRef.current);
        for (const q of fresh) {
          if (q.startedUtc && !nextLive.has(String(q.id))) {
            nextLive.set(String(q.id), { start: new Date(q.startedUtc), window: DEFAULT_WINDOW });
            changed = true;
          }
        }
        const gainedOptions = fresh.some(
          (f) => (f.options?.length || 0) > 0
            && ((tracksRef.current.find((t) => String(t.id) === String(f.id))?.options?.length) || 0) === 0,
        );
        tracksRef.current = fresh;
        setTracks(fresh);
        if (changed) {
          liveRef.current = nextLive;
          setLive(nextLive);
        }
        if (changed || gainedOptions) ensureTicking();
        if (revealedCount() >= fresh.length) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        /* transient — try again next tick */
      } finally {
        pollingRef.current = false;
      }
    }, POLL_MS);
  }

  function liveRemaining(q, lv) {
    const l = (lv || live).get(String(q.id));
    if (!l) return null;
    const rem = l.window - Math.floor((Date.now() - l.start.getTime()) / 1000);
    return rem > 0 ? rem : null;
  }

  function hasGuess(q) {
    return (song.get(String(q.id)) || '').trim().length > 0
      || (artist.get(String(q.id)) || '').trim().length > 0
      || (q.asksYear && Number.isFinite(parseInt(year.get(String(q.id)), 10)));
  }

  async function submit(qId, override) {
    const s = (override?.song ?? song.get(String(qId)) ?? '').trim();
    const a = (override?.artist ?? artist.get(String(qId)) ?? '').trim();
    const yRaw = override?.year ?? year.get(String(qId));
    const y = Number.isFinite(parseInt(yRaw, 10)) ? parseInt(yRaw, 10) : null;
    if (s.length === 0 && a.length === 0 && y == null) return;

    setBusy(true);
    setError(null);
    try {
      const res = await submitAnswer(activity.id, { questionId: qId, freeText: s, artistText: a, year: y });
      setResults((prev) => new Map(prev).set(String(qId), res));
      setAnswered((prev) => {
        const next = new Map(prev);
        next.set(String(qId), {
          questionId: qId,
          freeText: s,
          artistText: a,
          year: y,
          isCorrect: res.isCorrect,
          awardedPoints: res.awardedPoints,
        });
        answeredRef.current = next;
        return next;
      });
    } catch (e) {
      setError(e?.message || 'Kunde inte skicka svaret.');
    } finally {
      setBusy(false);
    }
  }

  // Tapping an artist option submits it as the artist guess (clears song/year).
  function submitChoice(qId, artistText) {
    setArtist((prev) => new Map(prev).set(String(qId), artistText));
    setSong((prev) => new Map(prev).set(String(qId), ''));
    setYear((prev) => new Map(prev).set(String(qId), ''));
    return submit(qId, { song: '', artist: artistText, year: '' });
  }

  if (loading) {
    return (
      <div className="card center muted" style={{ padding: '1.2rem' }}>
        <Spinner /> Laddar låtar…
      </div>
    );
  }
  if (tracks.length === 0) {
    return <div className="card muted">Inga låtar än — värden förbereder fortfarande.</div>;
  }

  const revealed = revealedCount();
  const total = tracks.length;
  const anyOptions = tracks.some((t) => isChoice(t));

  return (
    <div className="stack">
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Musikquiz</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Värden spelar låtarna en i taget — {anyOptions ? 'tryck på artisten' : 'skriv låt och artist'} när varje låt dyker upp. {answered.size} av {total} besvarade.
        </p>
        {error ? <div className="error-text">{error}</div> : null}
      </div>

      {tracks.map((q, i) => {
        const revealedHere = answered.has(String(q.id)) || live.has(String(q.id));
        if (!revealedHere) return null;
        const mine = answered.get(String(q.id));
        const res = results.get(String(q.id));
        const rem = mine ? null : liveRemaining(q, live);
        const choice = isChoice(q);
        // The answer window locks tap-the-artist rounds and, when speed scoring is
        // on, free-text rounds too — but never a plain (untimed) music quiz.
        const timeUp = !mine && (choice || activity.speedScoring) && live.has(String(q.id)) && rem == null;

        return (
          <div className="card stack" key={q.id}>
            <div className="row">
              <b className="grow">
                Track {i + 1}
                {hasLabel(q, i) ? ` · ${q.text}` : ''}
              </b>
              {rem != null && (activity.speedScoring || choice) ? (
                <span className="pill ok">⏱ {activity.speedScoring ? `svara snabbt · ${rem} s` : `${rem} s kvar`}</span>
              ) : timeUp ? (
                <span className="pill live">⏰ Tiden ute</span>
              ) : null}
              <span className="muted small">{q.points} p</span>
            </div>

            {!mine && choice && !timeUp ? (
              <div className="stack">
                {q.options.map((opt, oi) => (
                  <OptionButton
                    key={opt.id}
                    indexKey={OptionKey(oi, q.options.length)}
                    accent={optionColor(oi, q.options.length)}
                    text={opt.text}
                    mark=""
                    state=""
                    disabled={busy}
                    onClick={() => submitChoice(q.id, opt.text)}
                  />
                ))}
              </div>
            ) : timeUp ? (
              <div style={{ ...feedbackStyle(false), background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                ⏰ Tiden är ute — du hann inte låsa ett svar för den här låten.
              </div>
            ) : !mine ? (
              <div className="stack">
                <input
                  type="text"
                  placeholder="Låttitel"
                  value={song.get(String(q.id)) || ''}
                  onChange={(e) => setSong((prev) => new Map(prev).set(String(q.id), e.target.value))}
                />
                <input
                  type="text"
                  placeholder="Artist"
                  value={artist.get(String(q.id)) || ''}
                  onChange={(e) => setArtist((prev) => new Map(prev).set(String(q.id), e.target.value))}
                />
                {q.asksYear ? (
                  <input
                    type="number"
                    min={1860}
                    max={2100}
                    placeholder="Utgivningsår"
                    value={year.get(String(q.id)) || ''}
                    onChange={(e) => setYear((prev) => new Map(prev).set(String(q.id), e.target.value))}
                  />
                ) : null}
                <button className="btn block success" disabled={busy || !hasGuess(q)} onClick={() => submit(q.id)}>
                  Lås svar
                </button>
              </div>
            ) : (
              <AnsweredCard q={q} mine={mine} res={res} choice={choice} />
            )}
          </div>
        );
      })}

      {revealed === 0 ? (
        <div className="card center muted" style={{ padding: '1.1rem' }}>
          <Spinner /> Väntar på att värden ska spela första låten…
        </div>
      ) : revealed < total ? (
        <div className="card center muted small">
          ⏯ Väntar på att värden ska spela nästa låt — {total - revealed} kvar.
        </div>
      ) : null}
    </div>
  );
}

function AnsweredCard({ q, mine, res, choice }) {
  return (
    <div style={feedbackStyle(mine.awardedPoints > 0)}>
      <div>
        Du sa —{!choice ? <> Låt: <b>{shown(mine.freeText)}</b> ·</> : null} Artist: <b>{shown(mine.artistText)}</b>
        {!choice && q.asksYear ? ` · År: ${mine.year != null ? mine.year : '—'}` : ''}
      </div>
      {res ? (
        <div style={{ marginTop: '.25rem' }}>
          {!choice ? (
            <>
              Låt {res.songCorrect ? '✓' : '✗'}
              {res.correctSong ? ` — ${res.correctSong}` : ''}
              {' · '}
            </>
          ) : null}
          Artist {res.artistCorrect ? '✓' : '✗'}
          {res.correctArtist ? ` — ${res.correctArtist}` : ''}
          {!choice && res.correctYear != null ? ` · År ${res.yearPoints > 0 ? '✓' : '✗'} — ${res.correctYear}` : ''}
        </div>
      ) : null}
      <div style={{ marginTop: '.25rem', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
        <b>+{mine.awardedPoints}</b>
        {res?.elapsedSeconds != null ? (
          <span className="muted small">⏱ {res.elapsedSeconds} s</span>
        ) : null}
      </div>
    </div>
  );
}
