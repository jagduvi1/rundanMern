// ArcadePlay — the "arcade" presentation of a Musikquiz in Kahoot/speed mode: the
// full-screen, neon, thumb-first phone game players hold. It is an alternative
// renderer for an existing MusicQuiz activity (selected by Activity.jsx via
// ?arcade=1) — NOT a new game type. It reuses the exact same real data path as
// MusicQuizPlay:
//
//   • getQuestions / getMyAnswers          — load + restore state
//   • submitAnswer({questionId, artistText}) — tap-the-artist answer (Kahoot)
//   • MusicTrackStarted socket cue          — host plays a track → draining timer
//   • activity.speedScoring + server points — speed scoring is server-authoritative
//
// The arcade layer (draining timer, 🔥 streak, particle bursts, navigator.vibrate,
// confetti) is cosmetic chrome over that real data. The points shown are ALWAYS
// the server's awardedPoints — never a client-computed bonus — so the HUD can
// never disagree with the shared scoreboard. The streak counter is purely local.
//
// Props:
//   activity   : ActivityDto — { id, status, speedScoring, randomizeQuestions, ... }
//   participant: the joined player's session — { participantId, id, displayName }
//   board      : the live ScoreboardDto (owned/refreshed by Activity.jsx) — drives
//                the HUD rank/score and the final podium. May be null early.
//   onExit     : () => void — leave arcade mode (back to the standard view).
import { useEffect, useRef, useState } from 'react';
import { getQuestions } from '../api/questions';
import { submitAnswer, getMyAnswers } from '../api/gameplay';
import { getSocket } from '../utils/socket';
import { ServerEvents } from '../config/socketEvents';
import { ActivityStatus } from '../config/enums';
import { vibrate } from '../utils/vibrate';
import { OptionKey } from './QuizPlay';
import { createParticleEngine } from './arcade/fx';

const DEFAULT_WINDOW = 30; // seconds, when only startedUtc is known
const POLL_MS = 3000;
const TICK_MS = 200;
const TILE_COLORS = ['#4d7cff', '#ff6b3d', '#2ee6c8', '#ff3d8b', '#ffd23d', '#9b6bff'];
const FACES = ['🦊', '🐧', '🐝', '🐙', '🦄', '🐸', '🐼', '🚀', '👾', '🐯', '🦉', '🐬'];

const hashCode = (s) => {
  let h = 0;
  for (let i = 0; i < String(s).length; i += 1) h = (Math.imul(31, h) + String(s).charCodeAt(i)) | 0;
  return Math.abs(h);
};

export default function ArcadePlay({ activity, participant, board = null, onExit }) {
  const pid = String(participant?.participantId ?? participant?.id ?? '');
  const myName = participant?.displayName || 'Du';
  const face = FACES[hashCode(pid || myName) % FACES.length];

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [answered, setAnswered] = useState(() => new Map()); // qid → MyAnswerDto
  const [results, setResults] = useState(() => new Map()); // qid → AnswerResultDto
  const [live, setLive] = useState(() => new Map()); // qid → { start: Date, window: number }
  const [activeId, setActiveId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [streak, setStreak] = useState(0);
  const [, forceTick] = useState(0);
  // Free-text guesses (non-Kahoot tracks).
  const [song, setSong] = useState(() => new Map());
  const [artist, setArtist] = useState(() => new Map());
  const [yr, setYr] = useState(() => new Map());

  const disposed = useRef(false);
  const tickRef = useRef(null);
  const pollRef = useRef(null);
  const pollingRef = useRef(false);
  const tracksRef = useRef([]);
  const liveRef = useRef(new Map());
  const answeredRef = useRef(new Map());
  const canvasRef = useRef(null);
  const fxRef = useRef(null);

  tracksRef.current = tracks;
  liveRef.current = live;
  answeredRef.current = answered;

  // ── Particle engine (correct-answer bursts + win confetti) ───────────────────
  useEffect(() => {
    if (!canvasRef.current) return undefined;
    const fx = createParticleEngine(canvasRef.current);
    fxRef.current = fx;
    return () => { fx.destroy(); fxRef.current = null; };
  }, []);

  // ── Initial load (mirror of MusicQuizPlay) ───────────────────────────────────
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
        const lv = new Map();
        for (const q of qs) {
          if (q.startedUtc) lv.set(String(q.id), { start: new Date(q.startedUtc), window: DEFAULT_WINDOW });
        }
        tracksRef.current = qs; liveRef.current = lv; answeredRef.current = ans;
        setTracks(qs); setAnswered(ans); setLive(lv);
        setActiveId(pickActive(qs, lv));
        if (lv.size > 0) ensureTicking();
        if (revealedCount(qs, lv, ans) < qs.length) ensurePolling();
      } catch (e) {
        if (alive) setError(e?.message || 'Kunde inte ladda låtarna.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      disposed.current = true;
      if (tickRef.current) clearInterval(tickRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
      tickRef.current = null;
      pollRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id]);

  // ── Socket: the host's "track started" cue (page already joined the room) ─────
  useEffect(() => {
    let socket = null;
    let alive = true;
    const onStarted = (t) => {
      if (disposed.current || !t || String(t.activityId) !== String(activity.id)) return;
      setLive((prev) => {
        const next = new Map(prev);
        next.set(String(t.questionId), { start: new Date(t.startedUtc), window: t.windowSeconds || DEFAULT_WINDOW });
        liveRef.current = next;
        return next;
      });
      // Focus the freshly-played track (unless the player already answered it).
      if (!answeredRef.current.has(String(t.questionId))) setActiveId(t.questionId);
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

  // Re-render a few times a second while a track is counting down.
  function ensureTicking() {
    if (tickRef.current) return;
    tickRef.current = setInterval(() => {
      if (disposed.current) return;
      const anyLive = tracksRef.current.some((q) => remainingMs(q.id) != null && !answeredRef.current.has(String(q.id)));
      if (!anyLive) { clearInterval(tickRef.current); tickRef.current = null; }
      forceTick((n) => n + 1);
    }, TICK_MS);
  }

  // Backstop poll: catch a missed cue / options appearing after a late Kahoot flip.
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
        let newest = null;
        for (const q of fresh) {
          if (q.startedUtc && !nextLive.has(String(q.id))) {
            nextLive.set(String(q.id), { start: new Date(q.startedUtc), window: DEFAULT_WINDOW });
            changed = true;
            if (!newest || new Date(q.startedUtc) > newest.start) newest = { id: q.id, start: new Date(q.startedUtc) };
          }
        }
        tracksRef.current = fresh;
        setTracks(fresh);
        if (changed) {
          liveRef.current = nextLive;
          setLive(nextLive);
          if (newest && !answeredRef.current.has(String(newest.id))) setActiveId(newest.id);
          ensureTicking();
        }
        if (revealedCount(fresh, nextLive, answeredRef.current) >= fresh.length) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch { /* transient — next tick */ } finally {
        pollingRef.current = false;
      }
    }, POLL_MS);
  }

  function remainingMs(qid) {
    const l = liveRef.current.get(String(qid));
    if (!l) return null;
    const rem = l.window * 1000 - (Date.now() - l.start.getTime());
    return rem > 0 ? rem : null;
  }
  function remainingSec(qid) {
    const ms = remainingMs(qid);
    return ms == null ? null : Math.ceil(ms / 1000);
  }
  function remainingFrac(qid) {
    const l = liveRef.current.get(String(qid));
    if (!l) return 0;
    const frac = 1 - (Date.now() - l.start.getTime()) / (l.window * 1000);
    return Math.max(0, Math.min(1, frac));
  }

  // ── Answer a Kahoot track (tap the artist) ───────────────────────────────────
  async function pick(track, optionText, ev) {
    if (busy || answered.has(String(track.id))) return;
    setBusy(true);
    setError(null);
    const origin = burstOrigin(ev);
    try {
      const res = await submitAnswer(activity.id, {
        questionId: track.id, freeText: '', artistText: optionText, year: null,
      });
      if (disposed.current) return;
      setResults((prev) => new Map(prev).set(String(track.id), res));
      setAnswered((prev) => {
        const next = new Map(prev);
        next.set(String(track.id), {
          questionId: track.id, freeText: '', artistText: optionText, year: null,
          isCorrect: res.isCorrect, awardedPoints: res.awardedPoints,
        });
        answeredRef.current = next;
        return next;
      });
      celebrate(res, origin);
    } catch (e) {
      if (!disposed.current) setError(e?.message || 'Kunde inte skicka svaret.');
    } finally {
      if (!disposed.current) setBusy(false);
    }
  }

  // ── Answer a free-text track (plain music quiz fallback) ─────────────────────
  async function lockFreeText(track) {
    const s = (song.get(String(track.id)) || '').trim();
    const a = (artist.get(String(track.id)) || '').trim();
    const yRaw = yr.get(String(track.id));
    const y = Number.isFinite(parseInt(yRaw, 10)) ? parseInt(yRaw, 10) : null;
    if (s.length === 0 && a.length === 0 && y == null) return;
    if (busy || answered.has(String(track.id))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await submitAnswer(activity.id, { questionId: track.id, freeText: s, artistText: a, year: y });
      if (disposed.current) return;
      setResults((prev) => new Map(prev).set(String(track.id), res));
      setAnswered((prev) => {
        const next = new Map(prev);
        next.set(String(track.id), { questionId: track.id, freeText: s, artistText: a, year: y, isCorrect: res.isCorrect, awardedPoints: res.awardedPoints });
        answeredRef.current = next;
        return next;
      });
      celebrate(res, null);
    } catch (e) {
      if (!disposed.current) setError(e?.message || 'Kunde inte skicka svaret.');
    } finally {
      if (!disposed.current) setBusy(false);
    }
  }

  // Cosmetic reward layer — bursts/vibration/streak. Points come from the server.
  function celebrate(res, origin) {
    const won = (res?.awardedPoints || 0) > 0;
    if (won) {
      setStreak((n) => n + 1);
      vibrate([18, 30, 40]);
      const o = origin || { x: window.innerWidth / 2, y: window.innerHeight * 0.42 };
      fxRef.current?.burst(o.x, o.y, 54, 9);
    } else {
      setStreak(0);
      vibrate(120);
    }
  }

  function burstOrigin(ev) {
    try {
      const r = ev?.currentTarget?.getBoundingClientRect?.();
      if (r) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    } catch { /* fall through */ }
    return null;
  }

  // ── Win confetti when the activity finishes ──────────────────────────────────
  const finished = activity.status === ActivityStatus.Finished;
  useEffect(() => {
    if (!finished) return undefined;
    vibrate([40, 60, 90]);
    fxRef.current?.rain(140);
    const t = setTimeout(() => fxRef.current?.rain(120), 1300);
    return () => clearTimeout(t);
  }, [finished]);

  // ── Derived render state ─────────────────────────────────────────────────────
  const myEntry = board?.entries?.find((e) => String(e.participantId) === pid) || null;
  const myRank = myEntry?.rank ?? null;
  const myPoints = Number(myEntry?.totalPoints ?? 0);
  const total = tracks.length;
  const active = activeId ? tracks.find((t) => String(t.id) === String(activeId)) : null;

  return (
    <div className="arcade-root">
      <div className="arcade-aurora" aria-hidden="true"><span className="b b1" /><span className="b b2" /><span className="b b3" /></div>
      <div className="arcade-vig" aria-hidden="true" />

      {/* HUD */}
      {!finished ? (
        <div className="arcade-hud">
          <div className="arcade-me">
            <span className="arcade-face">{face}</span>
            <span className="arcade-me-text">
              <b>{myName}</b>
              <small>{activity.title}</small>
            </span>
          </div>
          <span className="grow" />
          {streak > 1 ? <span className="arcade-chip streak">🔥 {streak}</span> : null}
          {myRank ? <span className="arcade-chip">#{myRank}</span> : null}
          <span className="arcade-chip score">{fmt(myPoints)} p</span>
          {onExit ? (
            <button type="button" className="arcade-chip exit" onClick={onExit} aria-label="Lämna arkadläge">✕</button>
          ) : null}
        </div>
      ) : null}

      {/* progress dots */}
      {!finished && total > 0 ? (
        <div className="arcade-dots" aria-hidden="true">
          {tracks.map((t) => {
            const done = answered.has(String(t.id));
            const cur = String(t.id) === String(activeId);
            return <i key={t.id} className={done ? 'done' : cur ? 'cur' : ''} />;
          })}
        </div>
      ) : null}

      <div className="arcade-stage">
        {loading ? (
          <div className="arcade-center"><div className="arcade-spinner" /><p className="arcade-dim">Laddar…</p></div>
        ) : error ? (
          <div className="arcade-center"><p className="arcade-error">{error}</p></div>
        ) : finished ? (
          <ArcadeResults board={board} pid={pid} myPoints={myPoints} myRank={myRank} onExit={onExit} />
        ) : total === 0 ? (
          <Lobby face={face} name={myName} sub="Värden förbereder fortfarande låtarna…" onExit={onExit} />
        ) : !active ? (
          <Lobby face={face} name={myName} sub="⏳ Väntar på att värden spelar första låten — håll i dig!" onExit={onExit} />
        ) : (
          <ActiveTrack
            key={active.id}
            track={active}
            index={tracks.findIndex((t) => String(t.id) === String(active.id))}
            total={total}
            mine={answered.get(String(active.id)) || null}
            res={results.get(String(active.id)) || null}
            remSec={remainingSec(active.id)}
            remFrac={remainingFrac(active.id)}
            isLive={live.has(String(active.id))}
            speedScoring={!!activity.speedScoring}
            busy={busy}
            song={song} setSong={setSong} artist={artist} setArtist={setArtist} yr={yr} setYr={setYr}
            onPick={pick}
            onLock={lockFreeText}
          />
        )}
      </div>

      <canvas ref={canvasRef} className="arcade-fx" aria-hidden="true" />
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function Lobby({ face, name, sub, onExit }) {
  return (
    <div className="arcade-center">
      <img className="arcade-logo" src="/assets/gamedo-mark.svg" alt="" width="92" height="92" />
      <h1 className="arcade-title">Du är med! 🎉</h1>
      <span className="arcade-joined">{face} Inhoppad som <b>{name}</b></span>
      <p className="arcade-dim arcade-narrow">{sub}</p>
      {onExit ? <button type="button" className="arcade-textbtn" onClick={onExit}>Byt till vanlig vy</button> : null}
    </div>
  );
}

function ActiveTrack({
  track, index, total, mine, res, remSec, remFrac, isLive, speedScoring,
  busy, song, setSong, artist, setArtist, yr, setYr, onPick, onLock,
}) {
  const isKahoot = (track.options?.length || 0) > 0;
  const timeUp = !mine && isLive && remSec == null && (isKahoot || speedScoring);
  const label = track.text && track.text.trim() && track.text !== `Track ${index + 1}` ? track.text : null;

  return (
    <div className="arcade-q">
      <div className="arcade-qtop">
        <div className="arcade-qno">Låt {index + 1} av {total}{label ? ` · ${label}` : ''}</div>
        {!mine && isLive ? (
          <div className="arcade-timer"><i style={{ transform: `scaleX(${remFrac})` }} /></div>
        ) : null}
        {!mine && remSec != null ? (
          <div className="arcade-secs">{speedScoring ? `⚡ snabbt — ${remSec} s` : `${remSec} s`}</div>
        ) : null}
      </div>

      {mine ? (
        <Feedback mine={mine} res={res} />
      ) : timeUp ? (
        <div className="arcade-timeup">⏰ Tiden är ute — du hann inte låsa ett svar.</div>
      ) : isKahoot ? (
        <div className="arcade-tiles">
          {track.options.map((opt, i) => (
            <button
              key={opt.id}
              type="button"
              className="arcade-tile"
              style={{ '--tile': TILE_COLORS[i % TILE_COLORS.length] }}
              disabled={busy}
              onClick={(ev) => onPick(track, opt.text, ev)}
            >
              <span className="k">{OptionKey(i, track.options.length)}</span>
              <span className="lab">{opt.text}</span>
            </button>
          ))}
        </div>
      ) : (
        <FreeText track={track} song={song} setSong={setSong} artist={artist} setArtist={setArtist} yr={yr} setYr={setYr} busy={busy} onLock={onLock} />
      )}
    </div>
  );
}

function Feedback({ mine, res }) {
  const won = (mine.awardedPoints || 0) > 0;
  return (
    <div className={`arcade-fb ${won ? 'ok' : 'no'}`}>
      <span className="big">{won ? 'Rätt!' : 'Nära!'}</span>
      <span className="sub">
        {won ? 'Snyggt svarat' : 'Ingen panik — nästa kommer.'}
        {res?.correctArtist ? <><br />Rätt svar: <b>{res.correctArtist}</b></> : null}
        {res?.elapsedSeconds != null ? <span className="el"> · ⏱ {res.elapsedSeconds} s</span> : null}
      </span>
      <span className="pts">{won ? `+${mine.awardedPoints}` : ''}</span>
    </div>
  );
}

function FreeText({ track, song, setSong, artist, setArtist, yr, setYr, busy, onLock }) {
  const id = String(track.id);
  const has = (song.get(id) || '').trim() || (artist.get(id) || '').trim() || (track.asksYear && (yr.get(id) || '').trim());
  return (
    <div className="arcade-ft">
      <input className="arcade-input" placeholder="Låttitel" value={song.get(id) || ''} onChange={(e) => setSong((p) => new Map(p).set(id, e.target.value))} />
      <input className="arcade-input" placeholder="Artist" value={artist.get(id) || ''} onChange={(e) => setArtist((p) => new Map(p).set(id, e.target.value))} />
      {track.asksYear ? (
        <input className="arcade-input" type="number" min={1860} max={2100} placeholder="Utgivningsår" value={yr.get(id) || ''} onChange={(e) => setYr((p) => new Map(p).set(id, e.target.value))} />
      ) : null}
      <button type="button" className="arcade-lock" disabled={busy || !has} onClick={() => onLock(track)}>Lås svar</button>
    </div>
  );
}

function ArcadeResults({ board, pid, myPoints, myRank, onExit }) {
  const entries = board?.entries || [];
  const top = entries.slice(0, 3);
  const order = top.length === 3 ? [top[1], top[0], top[2]] : top; // silver · gold · bronze
  const heights = top.length === 3 ? [108, 150, 84] : top.map(() => 120);
  const title = myRank === 1 ? 'Du krossade det! 🏆' : myRank && myRank <= 3 ? 'Pallplats! 🎉' : 'Bra kämpat! 👏';
  return (
    <div className="arcade-center">
      <div className="arcade-kick">★ Resultat ★</div>
      <h1 className="arcade-title">{title}</h1>
      {top.length ? (
        <div className="arcade-podium">
          {order.map((e, i) => {
            const realRank = top.findIndex((t) => t === e) + 1;
            const me = String(e.participantId) === pid;
            return (
              <div className="pc" key={e.participantId}>
                <div className="pf" style={{ '--c': TILE_COLORS[realRank % TILE_COLORS.length] }}>{['🥈', '🥇', '🥉'][i] || '🏅'}</div>
                <div className={`pn ${me ? 'me' : ''}`}>{e.displayName}</div>
                <div className="pb" style={{ height: heights[i], '--c': TILE_COLORS[realRank % TILE_COLORS.length] }}>{fmt(e.totalPoints)}</div>
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="arcade-chip score" style={{ fontSize: 18, padding: '10px 18px' }}>
        {fmt(myPoints)} p{myRank ? ` · #${myRank}` : ''}
      </div>
      {onExit ? <button type="button" className="arcade-textbtn" onClick={onExit}>Se hela resultattavlan</button> : null}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────--
function fmt(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}
function pickActive(qs, lv) {
  let best = null;
  for (const q of qs) {
    const l = lv.get(String(q.id));
    if (!l) continue;
    if (!best || l.start > best.start) best = { id: q.id, start: l.start };
  }
  return best?.id ?? null;
}
function revealedCount(qs, lv, ans) {
  return qs.filter((q) => ans.has(String(q.id)) || lv.has(String(q.id))).length;
}
