// Cast — "/cast/:id" — the big-screen / TV projector view the host casts to the
// room. Full-bleed, landscape, read-only (NO host controls): it mirrors the real
// activity status and the real ScoreboardDto, so what the room sees is exactly the
// shared truth players are racing on. Three phases, driven by ActivityStatus:
//
//   Draft/Open → INTRO  : giant join code + QR + live player count ("scan & play").
//   Live       → RACE   : a crowned bar-race redrawn live on every ScoreboardUpdated.
//   Finished   → PODIUM : top-3 podium + confetti.
//
// Realtime mirrors Activity.jsx: join the room, react to ScoreboardUpdated +
// ActivityStatusChanged (+ ParticipantJoined for the lobby count), re-join on
// reconnect, and a 4s self-heal poll so a missed push always catches up.
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { getActivity, getScoreboard } from '../api/activities';
import { getEvent } from '../api/events';
import { listParticipants } from '../api/participants';
import { ApiError } from '../api/client';
import { ActivityStatus, ScoringMode } from '../config/enums';
import { ServerEvents } from '../config/socketEvents';
import { getSocket, joinActivity, leaveActivity } from '../utils/socket';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import { createParticleEngine } from '../components/arcade/fx';

const POLL_MS = 4000;
const MAX_LANES = 8;
const COLORS = ['#ffd23d', '#4d7cff', '#ff6b3d', '#2ee6c8', '#ff3d8b', '#9b6bff', '#34d399', '#f0a020'];
const FACES = ['🚀', '🦊', '🐝', '🐙', '🦄', '🐸', '🐼', '👾', '🐯', '🦉', '🐬', '🐧'];
const hashCode = (s) => {
  let h = 0;
  for (let i = 0; i < String(s).length; i += 1) h = (Math.imul(31, h) + String(s).charCodeAt(i)) | 0;
  return Math.abs(h);
};
const faceOf = (id) => FACES[hashCode(id) % FACES.length];
const colorOf = (id) => COLORS[hashCode(id) % COLORS.length];
const fmt = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
};

export default function Cast() {
  const { id } = useParams();
  const [activity, setActivity] = useState(null);
  const [board, setBoard] = useState(null);
  const [event, setEvent] = useState(null);
  const [playerCount, setPlayerCount] = useState(null);
  const [qr, setQr] = useState('');
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const disposed = useRef(false);
  const pollRef = useRef(null);
  const activityRef = useRef(null);
  const canvasRef = useRef(null);
  const fxRef = useRef(null);
  activityRef.current = activity;

  useDocumentTitle(`${activity?.title || 'Casta'} · GameDo`);

  // ── Particle engine (win confetti) ───────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return undefined;
    const fx = createParticleEngine(canvasRef.current);
    fxRef.current = fx;
    return () => { fx.destroy(); fxRef.current = null; };
  }, []);

  const refreshBoard = async () => {
    try { setBoard(await getScoreboard(id)); }
    catch (e) { if (!(e instanceof ApiError && e.status === 404)) { /* keep last */ } }
  };
  const refreshPlayers = async () => {
    try { setPlayerCount((await listParticipants(id)).length); } catch { /* transient */ }
  };

  // ── Initial load ──────────────────────────────────────────────────────────────
  useEffect(() => {
    disposed.current = false;
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    (async () => {
      let act;
      try {
        act = await getActivity(id);
      } catch (err) {
        if (!cancelled) {
          if (err instanceof ApiError && err.status === 404) setNotFound(true);
          setLoading(false);
        }
        return;
      }
      if (cancelled) return;
      if (!act) { setNotFound(true); setLoading(false); return; }
      setActivity(act);
      await Promise.all([refreshBoard(), refreshPlayers()]);
      if (cancelled) return;
      setLoading(false);
      // The QR points straight at this activity's join screen.
      QRCode.toDataURL(`${window.location.origin}/a/${act.id}`, { width: 320, margin: 1 })
        .then((d) => { if (!cancelled) setQr(d); })
        .catch(() => {});
      if (act.eventId) getEvent(act.eventId).then((ev) => { if (!cancelled && ev) setEvent(ev); }).catch(() => {});
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Realtime ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let socket = null;
    let active = true;

    const onScoreboard = (b) => {
      if (active && b && String(b.activityId) === String(id)) setBoard(b);
    };
    const onStatusChanged = async () => {
      if (!active) return;
      try {
        const fresh = await getActivity(id);
        if (active && fresh) setActivity(fresh);
        await refreshBoard();
      } catch { /* poll catches up */ }
    };
    const onParticipant = () => { if (active) refreshPlayers(); };
    function onReconnect() {
      joinActivity(id).catch(() => {});
      getActivity(id).then((a) => a && setActivity(a)).catch(() => {});
      refreshBoard();
      refreshPlayers();
    }

    (async () => {
      try {
        socket = await getSocket();
        if (!active) return;
        await joinActivity(id);
        socket.on(ServerEvents.ScoreboardUpdated, onScoreboard);
        socket.on(ServerEvents.ActivityStatusChanged, onStatusChanged);
        socket.on(ServerEvents.ParticipantJoined, onParticipant);
        socket.on('connect', onReconnect);
      } catch { /* poll-only fallback */ }
    })();

    return () => {
      active = false;
      if (socket) {
        socket.off(ServerEvents.ScoreboardUpdated, onScoreboard);
        socket.off(ServerEvents.ActivityStatusChanged, onStatusChanged);
        socket.off(ServerEvents.ParticipantJoined, onParticipant);
        socket.off('connect', onReconnect);
        leaveActivity(id).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Self-heal poll (4s) ───────────────────────────────────────────────────────
  useEffect(() => {
    pollRef.current = setInterval(async () => {
      if (disposed.current) return;
      try {
        const fresh = await getActivity(id);
        if (disposed.current || !fresh) return;
        setActivity(fresh);
        await refreshBoard();
        if (fresh.status === ActivityStatus.Open) refreshPlayers();
      } catch { /* next tick */ }
    }, POLL_MS);
    return () => { disposed.current = true; if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Win confetti on finish ──────────────────────────────────────────────────--
  const finished = activity?.status === ActivityStatus.Finished;
  useEffect(() => {
    if (!finished) return undefined;
    fxRef.current?.rain(170);
    const t1 = setTimeout(() => fxRef.current?.rain(140), 1400);
    const t2 = setTimeout(() => fxRef.current?.rain(140), 2800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [finished]);

  // ── Render ──────────────────────────────────────────────────────────────────--
  if (notFound) {
    return (
      <div className="cast-root">
        <div className="cast-stage">
          <h1 className="cast-h1">Hittades inte</h1>
          <p className="cast-empty">Ingen aktivitet med det id:t.</p>
          <Link className="arcade-textbtn" to="/events">Tillbaka</Link>
        </div>
      </div>
    );
  }

  const status = activity?.status;
  const entries = board?.entries || [];
  const phase = !activity || loading ? 'loading'
    : status === ActivityStatus.Finished ? 'podium'
      : status === ActivityStatus.Live ? 'race'
        : 'intro';

  return (
    <div className="cast-root">
      <div className="cast-aurora" aria-hidden="true"><span className="b b1" /><span className="b b2" /><span className="b b3" /></div>
      <div className="cast-vig" aria-hidden="true" />

      <div className="cast-topbar">
        <span className="cast-brand"><img src="/assets/gamedo-mark.svg" alt="" width="32" height="32" /> GameDo</span>
        <span style={{ flex: 1 }} />
        {activity ? (
          <span className="cast-live">
            <span className="cast-ldot" /> {status === ActivityStatus.Finished ? 'KLART' : 'LIVE'} · {activity.title}
          </span>
        ) : null}
      </div>

      <div className="cast-stage">
        {phase === 'loading' ? (
          <p className="cast-empty">Laddar…</p>
        ) : phase === 'intro' ? (
          <Intro activity={activity} event={event} qr={qr} playerCount={playerCount} entries={entries} />
        ) : phase === 'race' ? (
          <Race board={board} entries={entries} />
        ) : (
          <Podium entries={entries} />
        )}
      </div>

      <canvas ref={canvasRef} className="cast-fx" aria-hidden="true" />
    </div>
  );
}

function Intro({ activity, event, qr, playerCount, entries }) {
  const code = activity.joinCode || event?.joinCode || '';
  const count = playerCount ?? entries.length;
  return (
    <div className="cast-intro">
      <div className="lead">
        <div className="cast-kick">▸ Scanna &amp; spela</div>
        <h1 className="cast-h1">SPELA MED!</h1>
        {code ? (
          <div className="cast-codebox"><span>KOD</span><b>{code}</b></div>
        ) : null}
        <p className="cast-players"><b>{count}</b> {count === 1 ? 'spelare' : 'spelare'} i rummet 🎉</p>
      </div>
      {qr ? (
        <div className="cast-qr"><img src={qr} alt="QR-kod för att gå med" /></div>
      ) : null}
    </div>
  );
}

function Race({ board, entries }) {
  if (!entries.length) {
    return (
      <>
        <div className="cast-kick">Ställningen</div>
        <h1 className="cast-h1">Nu kör vi! 🎵</h1>
        <p className="cast-empty">De första poängen kommer strax…</p>
      </>
    );
  }
  const lanes = entries.slice(0, MAX_LANES);
  const maxPts = Math.max(1, ...lanes.map((e) => Number(e.totalPoints) || 0));
  const higher = board.scoringMode === ScoringMode.HigherWins || board.scoringMode == null;
  const barPct = (e) => {
    // HigherWins: fill by points. Lower/closest-wins: rank already encodes order,
    // so fill by position (rank-1 fullest) — never let the "loser" look like a win.
    if (higher) return Math.max(5, ((Number(e.totalPoints) || 0) / maxPts) * 100);
    return Math.max(5, ((entries.length - (e.rank - 1)) / entries.length) * 100);
  };
  return (
    <div style={{ width: '100%', maxWidth: 1000 }}>
      <h1 className="cast-h1" style={{ marginBottom: 18 }}>Ställningen <span style={{ color: 'var(--arc-orange)' }}>🔥</span></h1>
      <div className="cast-race">
        {lanes.map((e) => (
          <div className="cast-lane" key={e.participantId}>
            <div className="rk" style={{ color: colorOf(e.participantId) }}>{e.rank <= 3 ? ['🥇', '🥈', '🥉'][e.rank - 1] : e.rank}</div>
            <div className="face" style={{ '--c': colorOf(e.participantId) }}>
              {e.rank === 1 ? <span className="crown">👑</span> : null}
              {faceOf(e.participantId)}
            </div>
            <div className="cast-barwrap">
              <div className="cast-bar" style={{ width: `${barPct(e)}%`, '--c': colorOf(e.participantId) }} />
              <span className="nm">{e.displayName}</span>
              <span className="pt">{fmt(e.totalPoints)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Podium({ entries }) {
  const top = entries.slice(0, 3);
  const order = top.length === 3 ? [top[1], top[0], top[2]] : top; // silver · gold · bronze
  const heights = top.length === 3 ? [150, 210, 116] : top.map(() => 170);
  const winner = entries.find((e) => e.rank === 1);
  return (
    <>
      <div className="cast-kick">★ Mästare ★</div>
      <h1 className="cast-h1">{winner ? `${winner.displayName} vinner!` : 'Tack för spelet!'}</h1>
      {top.length ? (
        <div className="cast-podium">
          {order.map((e, i) => (
            <div className="cast-pcol" key={e.participantId}>
              <div className="cast-pface" style={{ '--c': colorOf(e.participantId) }}>{faceOf(e.participantId)}</div>
              <div className="cast-pname">{['🥈', '🥇', '🥉'][i]} {e.displayName}</div>
              <div className="cast-pbar" style={{ height: heights[i], '--c': colorOf(e.participantId) }}>{fmt(e.totalPoints)}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="cast-empty">Inga poäng registrerades.</p>
      )}
    </>
  );
}
