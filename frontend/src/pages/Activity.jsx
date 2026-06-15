// Activity — "/a/:id" — THE gameplay router (faithful port of rundan's
// Activity.razor). A big switch over ActivityType × ActivityStatus × (viewer |
// joined | host) that mounts the right play / results component. The play /
// editor components themselves are owned by sibling agents; this page is the
// decision tree + supporting chrome + the realtime/poll self-heal that makes
// "host pressed Start, every phone advances" work.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getActivity, getScoreboard } from '../api/activities';
import { getEvent } from '../api/events';
import { listParticipants } from '../api/participants';
import { getActivitySlap } from '../api/eventSocial';
import {
  getParticipantToken, setParticipantToken, getMemberToken, setMemberToken, ApiError,
} from '../api/client';
import { ActivityType, ActivityStatus, SlapState } from '../config/enums';
import { ServerEvents } from '../config/socketEvents';
import { getSocket, joinActivity as sockJoinActivity, leaveActivity } from '../utils/socket';
import {
  isViewer as readViewer, setViewer, getEventUserId, isProxying, getProxy, clearProxy,
} from '../utils/appState';
import { typeLabel, richHtml, rulesSummary } from '../utils/format';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import { useToast } from '../components/Toast';
import StatusBadge from '../components/StatusBadge';

import Scoreboard from '../components/Scoreboard';
import JoinPanel from '../components/JoinPanel';
import QuizPlay from '../components/QuizPlay';
import TipspromenadPlay from '../components/TipspromenadPlay';
import MemoryPlay from '../components/MemoryPlay';
import MusicQuizPlay from '../components/MusicQuizPlay';
import WordGamePlay from '../components/WordGamePlay';
import MapPinPlay from '../components/MapPinPlay';
import BouleBoard from '../components/BouleBoard';
import BracketBoard from '../components/BracketBoard';
import ResultsView from '../components/ResultsView';
import ResultsSummary from '../components/ResultsSummary';
import SlapCeremony from '../components/SlapCeremony';
import PhotoWall from '../components/PhotoWall';
import MusicHostPanel from '../components/MusicHostPanel';
import HitsterPlay from '../components/HitsterPlay';
import HitsterHostPanel from '../components/HitsterHostPanel';

const POLL_MS = 4000;
const PSESSION_KEY = (id) => `rundan.psession.${id}`;

// Player session metadata (participantId / displayName / isAdmin) stored beside
// the participant token (which client.js keeps for the header). Reconstructed on
// reload so the play components get a full session without a round-trip.
function readSession(activityId) {
  const token = getParticipantToken(activityId);
  if (!token) return null;
  try {
    const meta = JSON.parse(localStorage.getItem(PSESSION_KEY(activityId)) || 'null');
    return { token, ...(meta || {}) };
  } catch {
    return { token };
  }
}
function saveSession(activityId, session) {
  try {
    if (!session) {
      localStorage.removeItem(PSESSION_KEY(activityId));
      return;
    }
    const { id, participantId, displayName, isAdmin } = session;
    localStorage.setItem(
      PSESSION_KEY(activityId),
      JSON.stringify({ id: id ?? participantId, participantId: participantId ?? id, displayName, isAdmin }),
    );
  } catch { /* best effort */ }
}

export default function Activity() {
  const { id } = useParams();
  const { toast, show } = useToast();

  const [activity, setActivity] = useState(null);
  const [board, setBoard] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [session, setSession] = useState(null);
  const [slap, setSlap] = useState(null);
  const [siblings, setSiblings] = useState(null); // { prev, next, eventId, activities }
  const [viewer, setViewerState] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [scoreVersion, setScoreVersion] = useState(0);
  const [live, setLive] = useState('connecting'); // connecting | live | offline

  // Refs for handlers/poll that must read the latest without re-subscribing.
  const activityRef = useRef(null);
  const disposedRef = useRef(false);
  const pollRef = useRef(null);
  activityRef.current = activity;

  useDocumentTitle(`${activity?.title || 'Aktivitet'} · Rundan`);

  const participantId = session?.participantId ?? session?.id ?? null;
  const canManage = !isPreviewMode() && !!activity?.canManage;

  // ── Data loaders ────────────────────────────────────────────────────────────
  const refreshScoreboard = useCallback(async () => {
    try { setBoard(await getScoreboard(id)); } catch { /* transient */ }
  }, [id]);

  const loadSlap = useCallback(async () => {
    try {
      const s = await getActivitySlap(id);
      setSlap(s && s.state !== SlapState.None ? s : null);
    } catch { /* keep previous slap on transient error */ }
  }, [id]);

  const refreshParticipants = useCallback(async () => {
    try { setParticipants(await listParticipants(id)); } catch { /* transient */ }
  }, [id]);

  // ── Initial load ────────────────────────────────────────────────────────────
  useEffect(() => {
    disposedRef.current = false;
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
          else show(err?.message || 'Kunde inte ladda aktiviteten.');
          setLoading(false);
        }
        return;
      }
      if (cancelled) return;
      if (!act) { setNotFound(true); setLoading(false); return; }

      // Event-scoped identity + member token (mirror of the Event page): a "play
      // as" overlay from another event must not shadow this one's token.
      if (act.eventId) {
        if (isProxying() && getProxy()?.eventId !== String(act.eventId)) clearProxy();
        setViewerState(readViewer(act.eventId));

        // Attach THIS event's member token; if it differs from what the first GET
        // used, re-GET so canManage reflects our real event-admin status here.
        const proxy = getProxy();
        const sentToken = getMemberToken(act.eventId);
        if (!isProxying()) {
          // member token is already keyed per-event in client.js; nothing to copy.
        } else if (proxy?.eventId === String(act.eventId) && proxy.memberToken) {
          setMemberToken(act.eventId, proxy.memberToken);
        }
        if (getMemberToken(act.eventId) !== sentToken) {
          try { act = (await getActivity(id)) || act; } catch { /* keep */ }
        }
      }

      setActivity(act);
      setSession(readSession(id));

      // Independent reads together so the spinner doesn't wait on a serial chain.
      await Promise.all([refreshScoreboard(), refreshParticipants(), loadSlap()]);
      if (cancelled) return;
      setLoading(false);

      // Fetch sibling activities for nav (best-effort, non-blocking).
      if (act.eventId) {
        getEvent(act.eventId).then((ev) => {
          if (cancelled || !ev) return;
          const sorted = [...(ev.activities || [])].sort((a, b) => a.order - b.order);
          const idx = sorted.findIndex((a) => String(a.id) === String(id));
          setSiblings({
            eventId: act.eventId,
            activities: sorted,
            prev: idx > 0 ? sorted[idx - 1] : null,
            next: idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null,
          });
        }).catch(() => {});
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Realtime: join the activity room, refresh on pushes ─────────────────────
  useEffect(() => {
    let socket = null;
    let active = true;

    const onScoreboard = (b) => {
      if (!active) return;
      setBoard(b);
      setScoreVersion((v) => v + 1);
      if (activityRef.current?.status === ActivityStatus.Finished) loadSlap();
    };
    const onStatusChanged = async () => {
      if (!active) return;
      try {
        const fresh = await getActivity(id);
        if (!active || !fresh) return;
        setActivity(fresh);
        setScoreVersion((v) => v + 1);
        await Promise.all([refreshParticipants(), loadSlap(), refreshScoreboard()]);
      } catch { /* poll will catch up */ }
    };
    const onParticipant = () => { if (active) refreshParticipants(); };

    (async () => {
      try {
        socket = await getSocket();
        if (!active) return;
        await sockJoinActivity(id);
        setLive(socket.connected ? 'live' : 'connecting');
        socket.on(ServerEvents.ScoreboardUpdated, onScoreboard);
        socket.on(ServerEvents.ActivityStatusChanged, onStatusChanged);
        socket.on(ServerEvents.ParticipantJoined, onParticipant);
        socket.on('connect', onReconnect);
        socket.on('disconnect', onDisconnect);
      } catch {
        setLive('offline');
      }
    })();

    function onReconnect() {
      setLive('live');
      // Re-emit the room join (socket.io does not preserve rooms across reconnect)
      // and refetch in case a push was missed while offline.
      sockJoinActivity(id).catch(() => {});
      getActivity(id).then((a) => a && setActivity(a)).catch(() => {});
      refreshScoreboard();
      refreshParticipants();
      loadSlap();
    }
    function onDisconnect() { setLive('offline'); }

    return () => {
      active = false;
      if (socket) {
        socket.off(ServerEvents.ScoreboardUpdated, onScoreboard);
        socket.off(ServerEvents.ActivityStatusChanged, onStatusChanged);
        socket.off(ServerEvents.ParticipantJoined, onParticipant);
        socket.off('connect', onReconnect);
        socket.off('disconnect', onDisconnect);
        leaveActivity(id).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Self-heal poll (4s): a phone can miss a push; re-GET and catch up ────────
  useEffect(() => {
    disposedRef.current = false;
    pollRef.current = setInterval(async () => {
      const current = activityRef.current;
      if (disposedRef.current || !current) return;
      try {
        const fresh = await getActivity(id);
        if (disposedRef.current || !fresh) return;
        const statusChanged = fresh.status !== current.status;
        setActivity(fresh);
        if (statusChanged) {
          await Promise.all([refreshParticipants(), loadSlap()]);
          setScoreVersion((v) => v + 1);
        }
        await refreshScoreboard();
      } catch { /* transient — next tick */ }
    }, POLL_MS);

    return () => {
      disposedRef.current = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Actions ─────────────────────────────────────────────────────────────────
  const onJoined = useCallback(async (participant, token) => {
    // JoinPanel hands us the participant + its token; persist both, then refresh.
    const sess = {
      participantId: participant?.id ?? participant?.participantId,
      id: participant?.id ?? participant?.participantId,
      displayName: participant?.displayName,
      isAdmin: !!participant?.isAdmin,
      token,
    };
    if (token) setParticipantToken(id, token);
    saveSession(id, sess);
    setSession({ ...sess, token });
    await Promise.all([refreshParticipants(), refreshScoreboard()]);
    try { const a = await getActivity(id); if (a) setActivity(a); } catch { /* keep */ }
  }, [id, refreshParticipants, refreshScoreboard]);

  const watch = useCallback(() => {
    if (activity?.eventId) { setViewer(activity.eventId, true); setViewerState(true); }
  }, [activity]);
  const stopViewing = useCallback(() => {
    if (activity?.eventId) setViewer(activity.eventId, false);
    setViewerState(false);
  }, [activity]);

  const onSlapResolved = useCallback(async () => {
    await loadSlap();
    await refreshScoreboard();
  }, [loadSlap, refreshScoreboard]);

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (<>{toast}<div className="card center muted"><span className="spinner" style={{ margin: '1rem auto' }} /></div></>);
  }
  if (notFound || !activity) {
    return (
      <>
        {toast}
        <div className="card stack">
          <h1>Hittades inte</h1>
          <p className="muted">Ingen aktivitet med den koden eller id:t.</p>
          <Link className="btn" to="/events">Tillbaka till evenemang</Link>
        </div>
      </>
    );
  }

  return (
    <>
      {toast}
      {activity.eventId && siblings ? (
        <div className="row" style={navBar}>
          {siblings.prev ? (
            <Link className="btn ghost sm" to={`/a/${siblings.prev.id}`} title={siblings.prev.title}>‹ {siblings.prev.title}</Link>
          ) : <span />}
          <Link className="btn ghost sm" to={`/e/${activity.eventId}`}>Totalställning</Link>
          {siblings.next ? (
            <Link className="btn ghost sm" to={`/a/${siblings.next.id}`} title={siblings.next.title}>{siblings.next.title} ›</Link>
          ) : <span />}
        </div>
      ) : activity.eventId ? (
        <Link className="btn ghost sm" to={`/e/${activity.eventId}`} style={{ alignSelf: 'flex-start' }}>‹ Alla aktiviteter</Link>
      ) : null}

      <div className="card stack">
        <div className="row">
          <h1 className="grow" style={{ margin: 0 }}>{activity.title}</h1>
          <StatusBadge status={activity.status} />
        </div>
        <div className="row wrap muted small">
          <span>{typeLabel(activity.type)}</span>
          <span>·</span>
          <span>kod {activity.joinCode}</span>
          <span className="grow" />
          <LiveIndicator state={live} />
        </div>
      </div>

      {(activity.imageUrl || activity.description) ? (
        <div className="card stack">
          {activity.imageUrl ? <img src={activity.imageUrl} alt="" className="media-img" style={{ borderRadius: 'var(--radius-sm)' }} /> : null}
          {activity.description ? <div className="rte-content" dangerouslySetInnerHTML={richHtml(activity.description)} /> : null}
        </div>
      ) : null}

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Så funkar det</h2>
        <ul style={{ margin: '.1rem 0 0', paddingLeft: '1.15rem', lineHeight: 1.55 }}>
          {rulesSummary(activity).map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      </div>

      <div className="card">
        <h2>Resultattavla</h2>
        <Scoreboard activityId={activity.id} initial={board} highlightParticipantId={participantId} />
      </div>

      {slap ? (
        <SlapCeremony eventId={activity.eventId} activityId={activity.id} onResolved={onSlapResolved} />
      ) : null}

      {renderCentral({
        activity, session, viewer, participants, board, scoreVersion,
        canManage, participantId, onJoined, watch, stopViewing,
      })}

      {canManage && activity.type === ActivityType.MusicQuiz && activity.status !== ActivityStatus.Draft ? (
        activity.hitsterMode
          ? <HitsterHostPanel activity={activity} />
          : <MusicHostPanel activity={activity} />
      ) : null}

      {activity.status !== ActivityStatus.Draft ? (
        <PhotoWall activity={activity} participant={session} canManage={canManage} />
      ) : null}

      {activity.eventId && siblings ? (
        <div className="row" style={navBar}>
          {siblings.prev ? (
            <Link className="btn ghost sm" to={`/a/${siblings.prev.id}`}>‹ {siblings.prev.title}</Link>
          ) : <span />}
          <Link className="btn ghost sm" to={`/e/${activity.eventId}`}>Totalställning</Link>
          {siblings.next ? (
            <Link className="btn ghost sm" to={`/a/${siblings.next.id}`}>{siblings.next.title} ›</Link>
          ) : <span />}
        </div>
      ) : activity.eventId ? (
        <Link className="btn ghost block" to={`/e/${activity.eventId}`}>← Tillbaka till alla aktiviteter</Link>
      ) : null}

      {canManage && !isProxying() ? (
        <div className="card center muted">
          <Link to={`/manage/${activity.id}`}>Hantera den här aktiviteten (värd)</Link>
        </div>
      ) : null}
    </>
  );
}

// The central branch — the heart of the gameplay router (type × status × role).
function renderCentral(ctx) {
  const {
    activity, session, viewer, participants, scoreVersion,
    canManage, onJoined, watch, stopViewing,
  } = ctx;
  const { status, type } = activity;
  const usesQuestions = type === ActivityType.Quiz || type === ActivityType.Tipspromenad;
  const resultsTypes = [ActivityType.MusicQuiz, ActivityType.MapPin, ActivityType.Memory];

  // 1) Draft
  if (status === ActivityStatus.Draft) {
    return <div className="card muted">Den här aktiviteten har inte öppnat än. Värden håller på att förbereda den.</div>;
  }

  // 2) Viewer (spectator)
  if (viewer) {
    return (
      <>
        <div className="card stack center">
          <span className="pill">Åskådare</span>
          <p className="muted">Du tittar på den här aktiviteten — poängen uppdateras live ovan.</p>
          <button type="button" className="btn sm ghost" onClick={stopViewing}>Gå med och spela</button>
        </div>
        {type === ActivityType.Boule ? (
          <BracketBoard activity={activity} canManage={canManage} refreshKey={scoreVersion} />
        ) : status === ActivityStatus.Finished && usesQuestions ? (
          <ResultsView activity={activity} />
        ) : null}
      </>
    );
  }

  // 3) Not joined (not a viewer)
  if (!session) {
    if (status === ActivityStatus.Open || status === ActivityStatus.Live) {
      return (
        <>
          <JoinPanel activity={activity} onJoined={onJoined} />
          {activity.eventId ? (
            <div className="card center muted">
              <button type="button" className="btn ghost sm" onClick={watch}>Bara titta</button>
            </div>
          ) : null}
        </>
      );
    }
    if (status === ActivityStatus.Finished && usesQuestions) {
      return (<><ResultsView activity={activity} /><ResultsSummary activity={activity} /></>);
    }
    if (status === ActivityStatus.Finished && resultsTypes.includes(type)) {
      return <ResultsSummary activity={activity} />;
    }
    return <div className="card muted">Den här aktiviteten är avslutad.</div>;
  }

  // 4) Open (joined, lobby)
  if (status === ActivityStatus.Open) {
    return (
      <>
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Väntar på att värden ska starta…</h2>
          <p className="muted">Du är med som <b>{session.displayName || 'spelare'}</b>.</p>
        </div>
        <div className="card">
          <h2>{activity.isTeamBased ? 'Lag' : 'Spelare'} ({participants.length})</h2>
          <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 6 }}>
            {participants.map((p) => (
              <li key={p.id} className="row">
                <span className="grow">{p.displayName}</span>
                {p.isAdmin ? <span className="pill accent">värd</span> : null}
              </li>
            ))}
          </ul>
        </div>
      </>
    );
  }

  // 5) Live (joined) — mount the play component for the type
  if (status === ActivityStatus.Live) {
    switch (type) {
      case ActivityType.Quiz: return <QuizPlay activity={activity} participant={session} />;
      case ActivityType.Tipspromenad: return <TipspromenadPlay activity={activity} participant={session} />;
      case ActivityType.Boule: return <BracketBoard activity={activity} canManage={canManage} refreshKey={scoreVersion} />;
      case ActivityType.WordGame: return <WordGamePlay activity={activity} participant={session} />;
      case ActivityType.MapPin: return <MapPinPlay activity={activity} participant={session} />;
      case ActivityType.MusicQuiz: return activity.hitsterMode
        ? <HitsterPlay activity={activity} participant={session} />
        : <MusicQuizPlay activity={activity} participant={session} />;
      case ActivityType.Memory: return <MemoryPlay activity={activity} participant={session} />;
      default: return <BouleBoard activity={activity} participant={session} canManage={canManage} />;
    }
  }

  // 6) Finished (joined)
  if (usesQuestions) return (<><ResultsView activity={activity} /><ResultsSummary activity={activity} /></>);
  if (resultsTypes.includes(type)) return <ResultsSummary activity={activity} />;
  if (type === ActivityType.Boule) return <BracketBoard activity={activity} canManage={canManage} refreshKey={scoreVersion} />;
  if (type === ActivityType.WordGame) return <WordGamePlay activity={activity} participant={session} />;
  return (
    <div className="card success center">
      <h2>Slutresultat</h2>
      <p className="muted">Se resultattavlan ovan.</p>
    </div>
  );
}

const navBar = {
  justifyContent: 'space-between', gap: 6, padding: '.45rem .5rem',
  background: 'var(--surface)', borderRadius: 'var(--radius-sm, 8px)',
  border: '1px solid var(--border)', flexWrap: 'nowrap', overflow: 'hidden',
};

function LiveIndicator({ state }) {
  if (state === 'live') return <span className="pill ok" title="Liveuppdateringar är på">● Live</span>;
  if (state === 'offline') return <span className="pill live" title="Liveuppdateringar är av">● Offline</span>;
  return <span className="pill" title="Ansluter till liveuppdateringar">○ Ansluter…</span>;
}

// "Preview as player" is a device mode; importing the helper lazily keeps this
// file's import list tidy and avoids a circular dependency surprise.
function isPreviewMode() {
  try { return localStorage.getItem('rundan.preview') === '1'; } catch { return false; }
}
