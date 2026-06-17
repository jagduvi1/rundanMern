// MusicHostPanel — the host's live "now playing" panel for a MusicQuiz in progress.
// The React port of rundan's MusicHostPanel.razor. Lists the tracks; each "Start"
// reveals a track to players (POST .../music/start/:qid → emits MusicTrackStarted +
// starts a countdown) and, if speedScoring is on, begins a fastest-to-answer round.
// "Starta" reveals only; "▶ Spela" plays only; "▶ Starta & spela" does both. With a
// Spotify connection, playback uses the Web Playback SDK (useSpotifyPlayer, Premium
// required) and a "Spotify ↗" link is offered as an external fallback; without one,
// "▶ Spela" opens the track in Spotify. Host-only — mounted by Activity.jsx behind
// the canManage check.
//
// Props:
//   activity    : ActivityDto — reads { id, spotifyConnectionId, speedScoring, musicChoices }.
//   participant : the host's own player session (or null). When set AND the quiz is
//                 tap-the-artist (musicChoices), the host is "part of the competition"
//                 and answers the live track right here — the same options players get.
import { useCallback, useEffect, useRef, useState } from 'react';
import { startTrack } from '../api/music';
import { getAdminQuestions, getQuestions } from '../api/questions';
import { submitAnswer, getMyAnswers } from '../api/gameplay';
import { ActivityStatus, musicChoicePrompt, musicChoiceSubmit } from '../config/enums';
import { apiPost } from '../api/client';
import { useSpotifyPlayer } from '../utils/spotifyPlayer';
import { OptionButton, OptionKey, optionColor, feedbackStyle } from './QuizPlay';
import Spinner from './Spinner';

// Best-effort "wrap up the quiz if that was the last track" — no dedicated API
// helper exists, so call the endpoint directly (204, ignore failures).
const maybeFinishMusic = (activityId) =>
  apiPost(`/activities/${activityId}/music/maybe-finish`, {}, { activityId }).catch(() => {});

const secondsSince = (start) => Math.floor((Date.now() - start) / 1000);

export default function MusicHostPanel({ activity, participant }) {
  const canPlayInApp = activity?.spotifyConnectionId != null;
  // The host competes too when they have a player session, it's tap-the-artist mode,
  // and the quiz is actually live (the options + answering only exist while live).
  const competing = !!participant && !!activity?.musicChoices
    && activity?.status === ActivityStatus.Live;
  // The hook no-ops when connectionId is null, so it's safe to call unconditionally.
  const {
    ready, error: playerError, play, pause, resume, activate,
  } = useSpotifyPlayer(activity?.spotifyConnectionId || null);

  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Live (fastest-to-answer) round.
  const [live, setLive] = useState(null); // { id, start(ms), window(s) } | null
  const [, setTick] = useState(0); // forces a re-render each 500ms while live
  const tickerRef = useRef(null);
  const liveRef = useRef(null);
  liveRef.current = live;

  // In-app playback.
  const [playingId, setPlayingId] = useState(null);
  const [paused, setPaused] = useState(false);
  const [playBusy, setPlayBusy] = useState(false);
  const [playError, setPlayError] = useState(null);

  // Host-as-player answering (Kahoot mode): the same tap-the-artist options players get.
  const [optionsById, setOptionsById] = useState(() => new Map()); // qid → [{ id, text }]
  const [myAnswers, setMyAnswers] = useState(() => new Map());     // qid → my answer dto
  const [answerBusyId, setAnswerBusyId] = useState(null);
  const [answerError, setAnswerError] = useState(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Load tracks once.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const list = await getAdminQuestions(activity.id);
        if (alive) setTracks(list || []);
      } catch (e) {
        if (alive) setError(e?.message || 'Kunde inte ladda spåren.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [activity.id]);

  // When the host is competing, load the same tap-the-artist options players get
  // (player questions endpoint) plus the host's own answers so far. Best-effort:
  // the options only exist once the quiz is live, so this is re-run after a start.
  const loadChoices = useCallback(async () => {
    if (!competing) return;
    const [qs, mine] = await Promise.all([
      getQuestions(activity.id).catch(() => null),
      getMyAnswers(activity.id).catch(() => null),
    ]);
    if (!aliveRef.current) return;
    if (qs) {
      const m = new Map();
      for (const q of qs) m.set(String(q.id), { options: q.options || [], field: q.choiceField || 'artist' });
      setOptionsById(m);
    }
    // Merge (never drop) so a refetch can't transiently wipe an optimistic answer.
    if (mine) {
      setMyAnswers((prev) => {
        const m = new Map(prev);
        for (const a of mine) m.set(String(a.questionId), a);
        return m;
      });
    }
  }, [activity.id, competing]);

  useEffect(() => { loadChoices(); }, [loadChoices]);

  // Countdown ticker — computes remaining from timestamps so it's resilient to tab
  // throttling. When it reaches 0, stop and call maybe-finish once.
  function ensureTicking() {
    if (tickerRef.current) return;
    tickerRef.current = setInterval(() => {
      const cur = liveRef.current;
      if (!cur) {
        clearInterval(tickerRef.current);
        tickerRef.current = null;
        return;
      }
      const remaining = Math.max(0, cur.window - secondsSince(cur.start));
      if (remaining <= 0) {
        clearInterval(tickerRef.current);
        tickerRef.current = null;
        if (aliveRef.current) setLive(null);
        maybeFinishMusic(activity.id);
      } else if (aliveRef.current) {
        setTick((n) => n + 1);
      }
    }, 500);
  }

  useEffect(() => () => {
    if (tickerRef.current) clearInterval(tickerRef.current);
  }, []);

  async function startRound(t, { autoPlay = false } = {}) {
    if (canPlayInApp) activate();
    setBusy(true);
    setError(null);
    try {
      const res = await startTrack(activity.id, t.id);
      if (!aliveRef.current) return;
      setLive({
        id: res?.questionId ?? t.id,
        start: res?.startedUtc ? new Date(res.startedUtc).getTime() : Date.now(),
        window: res?.windowSeconds || 30,
      });
      ensureTicking();
      if (competing) loadChoices(); // options become available once a track is live
      if (autoPlay && t.spotifyUrl && t.spotifyUrl.trim()) {
        playTrack(t);
      }
    } catch (e) {
      setError(e?.message || 'Kunde inte starta spåret.');
    } finally {
      setBusy(false);
    }
  }

  async function playTrack(t) {
    if (!(t.spotifyUrl && t.spotifyUrl.trim())) return;
    if (!canPlayInApp) {
      window.open(t.spotifyUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    activate(); // unlock audio within the click gesture (autoplay policy)
    setPlayBusy(true);
    setPlayError(null);
    try {
      if (!ready) {
        setPlayError('Kunde inte starta spelaren i appen — kontrollera att det anslutna kontot är Spotify Premium. Du kan fortfarande använda ”Spotify ↗”-länken.');
        return;
      }
      const ok = await play(t.spotifyUrl);
      if (ok) {
        setPlayingId(t.id);
        setPaused(false);
      } else {
        setPlayError('Spotify ville inte starta det spåret. Prova ”Spotify ↗”-länken.');
      }
    } catch (e) {
      setPlayError(e?.message || 'Uppspelningen misslyckades.');
    } finally {
      setPlayBusy(false);
    }
  }

  async function togglePause() {
    setPlayBusy(true);
    try {
      if (paused) await resume(); else await pause();
      setPaused((p) => !p);
    } catch {
      /* best effort */
    } finally {
      setPlayBusy(false);
    }
  }

  // The host taps an option for the live track (same call players make) — the option
  // is the artist or the title, per the track's choiceField.
  async function submitChoice(t, optionText, field) {
    // Ignore taps while a submit is in flight or this track is already answered
    // (the backend dedups anyway, but this keeps the optimistic state consistent).
    if (!participant || answerBusyId || myAnswers.has(String(t.id))) return;
    setAnswerBusyId(t.id);
    setAnswerError(null);
    try {
      const res = await submitAnswer(activity.id, {
        questionId: t.id, ...musicChoiceSubmit(field, optionText), year: null,
      });
      if (!aliveRef.current) return;
      // Store the SAME shape the server returns ({ freeText, artistText }) so the
      // next loadChoices merge (which overwrites by questionId) doesn't blank the
      // displayed answer — getMyAnswers has no `answerText` field.
      setMyAnswers((prev) => new Map(prev).set(String(t.id), {
        questionId: t.id,
        ...musicChoiceSubmit(field, optionText),
        isCorrect: res?.isCorrect,
        awardedPoints: res?.awardedPoints,
      }));
    } catch (e) {
      setAnswerError(e?.message || 'Kunde inte skicka svaret.');
    } finally {
      setAnswerBusyId(null);
    }
  }

  // The host's own answer block for a track (only when competing in Kahoot mode):
  // tap-the-artist options while the track is live, then the host's pick + result.
  function hostAnswer(t, isLive) {
    const mine = myAnswers.get(String(t.id));
    if (mine) {
      // Correctness from the awarded score (authoritative, and works even when the
      // host hid the answers from themselves) — mirrors the player view's reveal.
      const gotIt = (mine.awardedPoints || 0) > 0;
      // The tapped value lives in artistText (artist tracks) or freeText (title
      // tracks) — whichever the track's choiceField submitted.
      const answered = mine.artistText || mine.freeText;
      return (
        <div style={feedbackStyle(gotIt)}>
          Du svarade: <b>{answered && answered.trim() ? answered : '—'}</b>
          {` ${gotIt ? '✓' : '✗'}`}
          {mine.awardedPoints != null ? <> · <b>+{mine.awardedPoints}</b></> : null}
        </div>
      );
    }
    if (!isLive) return null;
    const entry = optionsById.get(String(t.id)) || { options: [], field: 'artist' };
    const opts = entry.options;
    if (opts.length === 0) return <span className="muted small">Laddar svarsalternativ…</span>;
    return (
      <div className="stack" style={{ gap: '.3rem' }}>
        <span className="muted small">Ditt svar (du tävlar också) — {musicChoicePrompt(entry.field)}</span>
        {opts.map((opt, oi) => (
          <OptionButton
            key={opt.id}
            indexKey={OptionKey(oi, opts.length)}
            accent={optionColor(oi, opts.length)}
            text={opt.text}
            mark=""
            state=""
            disabled={answerBusyId != null}
            onClick={() => submitChoice(t, opt.text, entry.field)}
          />
        ))}
        {answerError ? <div className="error-text">{answerError}</div> : null}
      </div>
    );
  }

  if (loading) {
    return <div className="card center muted"><Spinner /></div>;
  }

  const playingIndex = tracks.findIndex((t) => t.id === playingId);
  const playingLabel = playingIndex >= 0 ? `Spår ${playingIndex + 1}` : '';
  const liveRemaining = live ? Math.max(0, live.window - secondsSince(live.start)) : 0;

  return (
    <div className="card stack" style={{ borderColor: 'var(--accent)' }}>
      <h2 style={{ margin: 0 }}>Spår att spela (värd)</h2>
      <p className="muted small" style={{ margin: 0 }}>
        {canPlayInApp
          ? 'Spela hela spår här med din Spotify Premium-anslutning, eller öppna dem i Spotify. '
          : 'Spela varje spår högt. '}
        Tryck <b>Starta & spela</b> för att avslöja ett spår för spelarna och spela upp det
        {activity.speedScoring
          ? ` och starta en snabbast-svar-runda — rätt svar ger 100 poäng minus antalet sekunder det tog att svara.`
          : '.'}
        {' '}Spelarna ser ett spår först när du startat det, och i tryck-på-artisten-läget låses deras val när tiden går ut. Den här panelen är bara din.
      </p>

      {error ? <div className="error-text">{error}</div> : null}
      {(playError || playerError) ? <div className="error-text">{playError || playerError}</div> : null}

      {canPlayInApp && playingId != null ? (
        <div className="row" style={{ gap: '.5rem', alignItems: 'center', background: 'var(--accent-soft, #f3f0ea)', borderRadius: 10, padding: '.4rem .6rem' }}>
          <span className="grow"><b>♪ Spelar</b> {playingLabel}</span>
          <button type="button" className="btn sm" onClick={togglePause} disabled={playBusy}>{paused ? '▶ Återuppta' : '⏸ Pausa'}</button>
        </div>
      ) : null}

      <ul style={listStyle}>
        {tracks.map((t, i) => {
          const isLive = live?.id === t.id;
          return (
            <li key={t.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '.3rem' }}>
              <div className="row wrap">
                <b className="grow">Spår {i + 1}</b>
                {isLive ? <span className="pill live">▶ LIVE · {liveRemaining} s</span> : null}
                <button type="button" className="btn sm ghost" onClick={() => startRound(t)} disabled={busy}>
                  {isLive ? 'Starta om' : 'Starta'}
                </button>
                {t.spotifyUrl && t.spotifyUrl.trim() ? (
                  <>
                    <button type="button" className="btn sm" onClick={() => playTrack(t)} disabled={playBusy} title={canPlayInApp ? 'Spela hela spåret i appen (Premium)' : 'Öppna i Spotify'}>▶ Spela</button>
                    <button type="button" className="btn sm success" onClick={() => startRound(t, { autoPlay: true })} disabled={busy}>▶ Starta & spela</button>
                    {/* External fallback for Premium hosts (the failure messages point
                        here when in-app playback won't start). Non-Premium hosts already
                        open Spotify via "▶ Spela", so the link would be redundant there. */}
                    {canPlayInApp ? (
                      <a className="btn sm ghost" href={t.spotifyUrl} target="_blank" rel="noopener noreferrer" title="Öppna spåret i Spotify">Spotify ↗</a>
                    ) : null}
                  </>
                ) : null}
              </div>
              <div className="muted" style={{ fontSize: '.82rem' }}>
                {t.hidden ? (
                  <span>Svar dolt medan du spelar</span>
                ) : (
                  <span>
                    Svar: <b>{t.acceptedFreeTextAnswer && t.acceptedFreeTextAnswer.trim() ? t.acceptedFreeTextAnswer : '—'}</b>
                    {' av '}
                    <b>{t.acceptedArtist && t.acceptedArtist.trim() ? t.acceptedArtist : '—'}</b>
                    {t.releaseYear != null ? ` · ${t.releaseYear}` : ''}
                  </span>
                )}
                {' · '}<b>{t.points} p</b>
              </div>
              {competing ? hostAnswer(t, isLive) : null}
            </li>
          );
        })}
      </ul>

    </div>
  );
}

const listStyle = { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 };
