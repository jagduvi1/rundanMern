// Event — "/e/:id" — THE event hub (port of rundan's Event.razor). The central
// page: standings, group chat, identity (claim/join/viewer), the activities
// running order with geofence/arrival, the per-activity slap ceremonies, and the
// host control panel. Both the player view AND the host management surface live
// here; what shows depends on canManage (server-computed) + viewer/joined state.
//
// Realtime + geolocation are set up in effects and torn down on unmount; the page
// keys off :id so a route-param change fully remounts (rundan reloaded manually).
//
// Contract gaps vs doc 09 (no MERN endpoint): event-wide "add from library",
// "simulate all" as one call (we loop per-activity simulate instead), and a
// score-clearing "restart event" (the closest supported op is "reset all
// activities" to Draft/Open, which keeps scores) — noted inline.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  getEvent, getStandings, getTeams, reshuffleTeams, setMembers, updateEvent,
  setEventCode, setCoAdmins, reorderActivities, setActivitiesStatus, arrive, joinEvent, claimEvent,
  claimEventAsMe,
} from '../api/events';
import { inviteToEvent } from '../api/invites';
import { getFriends } from '../api/me';
import { createActivity, setActivityStatus, deleteActivity } from '../api/activities';
import { simulate, resetResults } from '../api/simulation';
import {
  getChat, postChat, registerViewer, getActivitySlap,
} from '../api/eventSocial';
import {
  setParticipantToken, setMemberToken, ApiError,
} from '../api/client';
import {
  ActivityType, ActivityStatus, EventScoring, TeamShuffle, SlapMode, SlapState,
} from '../config/enums';
import { ServerEvents } from '../config/socketEvents';
import {
  getSocket, joinEvent as sockJoinEvent, leaveEvent, joinActivity as sockJoinActivity,
} from '../utils/socket';
import {
  saveLastEventId, getEventName, saveEventName, getEventUserId, saveEventUserId,
  isViewer as readViewer, getViewerName, getViewerToken, setViewer,
  isProxying, getProxy, isPreview, setPreview,
} from '../utils/appState';
import { useGeolocation, distanceMeters } from '../utils/useGeolocation';
import { vibrate } from '../utils/vibrate';
import { subscribeToPush, isPushSupported } from '../utils/push';
import { num, richHtml, typeLabel } from '../utils/format';
import { useBootstrap } from '../contexts/BootstrapContext';
import { useAuth } from '../contexts/AuthContext';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import { useToast } from '../components/Toast';
import StatusBadge from '../components/StatusBadge';
import Pill from '../components/Pill';
import SlapCeremony from '../components/SlapCeremony';
import QrShareModal from '../components/QrShareModal';
import MapView from '../components/MapView';

const ARRIVAL_RADIUS = 40;
const HOST_TYPES = [
  ActivityType.Quiz, ActivityType.Tipspromenad, ActivityType.Boule, ActivityType.ScoreGame,
  ActivityType.WordGame, ActivityType.MapPin, ActivityType.MusicQuiz, ActivityType.Memory,
];

const actionLabel = (status) => ({
  [ActivityStatus.Live]: 'Spela nu',
  [ActivityStatus.Open]: 'Gå med i lobbyn',
  [ActivityStatus.Finished]: 'Se resultat',
  [ActivityStatus.Draft]: 'Öppna',
}[status] || 'Öppna');

// The host's status transitions, given the current status.
function hostActions(status) {
  switch (status) {
    case ActivityStatus.Draft: return [['Öppna lobby', ActivityStatus.Open]];
    case ActivityStatus.Open: return [['Starta', ActivityStatus.Live]];
    case ActivityStatus.Live: return [['Avsluta', ActivityStatus.Finished]];
    case ActivityStatus.Finished: return [['Öppna igen', ActivityStatus.Live]];
    default: return [];
  }
}

export default function Event() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast, show } = useToast();
  const { hasWebPush } = useBootstrap();
  const { user } = useAuth();

  const [event, setEvent] = useState(null);
  const [standings, setStandings] = useState(null);
  const [chat, setChat] = useState([]);
  const [slapByActivity, setSlapByActivity] = useState({});
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  // Player identity (this device).
  const [eventName, setEventName] = useState(getEventName(id));
  const [viewer, setViewerState] = useState(false);
  const [viewerNameSaved, setViewerNameSaved] = useState(getViewerName(id));

  // Form/UI state.
  const [joinName, setJoinName] = useState('');
  const [viewerName, setViewerName] = useState('');
  const [chatText, setChatText] = useState('');
  const [busy, setBusy] = useState(false);
  const [infoOpen, setInfoOpen] = useState(true);
  const [arrivedId, setArrivedId] = useState(null);
  const [shareOpen, setShareOpen] = useState(false); // QR/share modal (render-only)

  const eventRef = useRef(null);
  eventRef.current = event;
  const seenInsideRef = useRef(new Set());
  const lastArrivalPostRef = useRef(0);

  useDocumentTitle(`${event?.name || 'Evenemang'} · Rundan`);

  const proxy = getProxy();
  const proxyHere = isProxying() && proxy?.eventId === String(id);
  // "Preview as player": a host can flip into the exact player view to see what
  // their guests see. While previewing, canManage is false so the host branch is
  // skipped; a banner lets them flip back.
  const [previewMode, setPreviewMode] = useState(isPreview());
  const isReallyHost = !!event?.canManage;
  const canManage = isReallyHost && !previewMode;
  const togglePreview = (on) => {
    setPreview(on);
    setPreviewMode(on);
    try { window.scrollTo(0, 0); } catch { /* ignore */ }
  };
  const previewBanner = (isReallyHost && previewMode) ? (
    <div className="card" style={{ border: '1px solid var(--accent)', background: 'var(--accent-soft)' }}>
      <div className="spread">
        <span><b>👁 Spelarvy</b> — så här ser dina spelare evenemanget.</span>
        <button type="button" className="btn sm" onClick={() => togglePreview(false)}>← Tillbaka till värdläget</button>
      </div>
    </div>
  ) : null;

  const eventUnderway = !!event && (event.activities || []).some(
    (a) => a.status === ActivityStatus.Live || a.status === ActivityStatus.Finished,
  );
  const eventAvailableNow = availableNow(event);
  const eventOpenForMe = eventAvailableNow || canManage;

  const isMe = useCallback((name) => {
    if (proxyHere && proxy?.name) return name === proxy.name;
    return !!eventName && name === eventName;
  }, [proxyHere, proxy, eventName]);

  // ── Loaders ─────────────────────────────────────────────────────────────────
  const refreshStandings = useCallback(async () => {
    try { setStandings(await getStandings(id)); } catch { /* transient */ }
  }, [id]);

  const loadSlaps = useCallback(async (ev) => {
    const finished = (ev?.activities || []).filter((a) => a.status === ActivityStatus.Finished);
    const results = await Promise.allSettled(finished.map((a) => getActivitySlap(a.id)));
    const map = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value && r.value.state !== SlapState.None) {
        map[finished[i].id] = r.value;
      }
    });
    setSlapByActivity(map);
  }, []);

  const reload = useCallback(async () => {
    try {
      const ev = await getEvent(id);
      if (!ev) { setNotFound(true); return null; }
      setEvent(ev);
      await Promise.all([refreshStandings(), loadSlaps(ev)]);
      return ev;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else show(err?.message || 'Kunde inte ladda evenemanget.');
      return null;
    }
  }, [id, refreshStandings, loadSlaps, show]);

  // ── Initial load ────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setEventName(getEventName(id));
    setViewerState(readViewer(id));
    setViewerNameSaved(getViewerName(id));

    (async () => {
      let ev;
      try {
        ev = await getEvent(id);
      } catch (err) {
        if (!cancelled) {
          if (err instanceof ApiError && err.status === 404) setNotFound(true);
          else show(err?.message || 'Kunde inte ladda evenemanget.');
          setLoading(false);
        }
        return;
      }
      if (cancelled) return;
      if (!ev) { setNotFound(true); setLoading(false); return; }

      setEvent(ev);
      saveLastEventId(id);
      setInfoOpen(!(ev.activities || []).some((a) => a.status === ActivityStatus.Live || a.status === ActivityStatus.Finished));

      // Re-claim / re-join to refresh per-activity sessions for newly opened
      // activities (so a player who joined earlier can play the next one).
      try {
        if (ev.hasRoster) {
          const uid = getEventUserId(id);
          if (uid) {
            const res = await claimEvent(ev.joinCode, uid);
            persistClaim(id, res);
            if (!cancelled) setEventName(res.displayName);
          }
        } else if (getEventName(id)) {
          const res = await joinEvent(ev.joinCode, getEventName(id));
          persistJoin(id, res);
        }
      } catch { /* identity refresh is best-effort */ }

      // Viewer heartbeat.
      if (!cancelled && readViewer(id)) {
        try {
          const res = await registerViewer(id, getViewerName(id) || 'Åskådare', getViewerToken(id) || undefined);
          if (res) { setViewer(id, true, res.name, res.token); setViewerNameSaved(res.name); }
        } catch { /* ignore */ }
      }

      const [st] = await Promise.all([getStandings(id).catch(() => null), loadSlaps(ev)]);
      if (cancelled) return;
      setStandings(st);
      try { setChat(await getChat(id)); } catch { /* chat unavailable */ }
      setLoading(false);
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Realtime ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let socket = null;
    let active = true;

    const onRefresh = () => { if (active) reload(); };
    const onViewers = (dto) => {
      if (!active) return;
      setEvent((e) => (e ? { ...e, viewers: dto?.viewers ?? dto?.Viewers ?? e.viewers } : e));
    };
    const onChat = (msg) => {
      if (!active || !msg) return;
      setChat((list) => (list.some((m) => m.id === msg.id) ? list : [...list, msg]));
    };

    (async () => {
      try {
        socket = await getSocket();
        if (!active) return;
        await sockJoinEvent(id);
        // Join each activity room too (mirrors rundan's StartAsync(activityIds)).
        for (const a of (eventRef.current?.activities || [])) sockJoinActivity(a.id).catch(() => {});
        socket.on(ServerEvents.ScoreboardUpdated, onRefresh);
        socket.on(ServerEvents.ActivityStatusChanged, onRefresh);
        socket.on(ServerEvents.EventChanged, onRefresh);
        socket.on(ServerEvents.ViewersChanged, onViewers);
        socket.on(ServerEvents.ChatPosted, onChat);
        socket.on('connect', onReconnect);
        socket.on('disconnect', onDisconnect);
      } catch { /* live unavailable; the page still works */ }
    })();

    function onReconnect() {
      setReconnecting(false);
      sockJoinEvent(id).catch(() => {});
      for (const a of (eventRef.current?.activities || [])) sockJoinActivity(a.id).catch(() => {});
      reload();
    }
    function onDisconnect() { setReconnecting(true); }

    return () => {
      active = false;
      if (socket) {
        socket.off(ServerEvents.ScoreboardUpdated, onRefresh);
        socket.off(ServerEvents.ActivityStatusChanged, onRefresh);
        socket.off(ServerEvents.EventChanged, onRefresh);
        socket.off(ServerEvents.ViewersChanged, onViewers);
        socket.off(ServerEvents.ChatPosted, onChat);
        socket.off('connect', onReconnect);
        socket.off('disconnect', onDisconnect);
        leaveEvent(id).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Geolocation + arrival prompts ──────────────────────────────────────────
  const { coords, start: startGeo } = useGeolocation();
  const located = (event?.activities || []).filter((a) => a.hasLocation);
  const needsGeo = !viewer && located.length > 0;

  useEffect(() => { if (needsGeo) startGeo(); }, [needsGeo, startGeo]);

  useEffect(() => {
    if (!coords || !event) return;
    const firstFix = seenInsideRef.current.size === 0 && !arrivedId;
    for (const a of event.activities || []) {
      if (!a.hasLocation) continue;
      const d = distanceMeters(coords.lat, coords.lng, a.latitude, a.longitude);
      const radius = a.radiusMeters || ARRIVAL_RADIUS;
      const inside = d <= radius;
      const key = String(a.id);
      const wasInside = seenInsideRef.current.has(key);
      const playable = a.status === ActivityStatus.Open || a.status === ActivityStatus.Live;

      if (inside) {
        seenInsideRef.current.add(key);
        // On the first fix, treat activities we're already inside as "seen" so it
        // doesn't pop on page load.
        if (!wasInside && !firstFix && playable) {
          setArrivedId(a.id);
          vibrate([90, 50, 140]);
        }
      } else {
        seenInsideRef.current.delete(key);
      }
    }
    // Report GPS so the server can auto-start any open geofenced activity we entered.
    const nowMs = Date.now();
    if (nowMs - lastArrivalPostRef.current >= 8000) {
      lastArrivalPostRef.current = nowMs;
      arrive(id, coords.lat, coords.lng).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords, event]);

  // ── Player actions ──────────────────────────────────────────────────────────
  const claim = async (userId) => {
    setBusy(true);
    try {
      const res = await claimEvent(event.joinCode, userId);
      persistClaim(id, res);
      setEventName(res.displayName);
      await refreshStandings();
      await reload();
    } catch (err) {
      show(err?.message || 'Kunde inte gå med.');
    } finally {
      setBusy(false);
    }
  };

  // "Spela som mig" — a logged-in account claims its OWN linked roster identity
  // (no userId; the backend resolves it). Falls through to the same persistence
  // as a normal claim so this device re-presents the right identity afterwards.
  const claimAsMe = async () => {
    setBusy(true);
    try {
      const res = await claimEventAsMe(event.joinCode);
      persistClaim(id, res);
      setEventName(res.displayName);
      await refreshStandings();
      await reload();
    } catch (err) {
      show(err?.message || 'Kunde inte spela som dig — be värden lägga till dig i evenemanget.');
    } finally {
      setBusy(false);
    }
  };

  const joinFreeName = async () => {
    const name = joinName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const res = await joinEvent(event.joinCode, name);
      persistJoin(id, res);
      saveEventName(id, res.displayName || name);
      setEventName(res.displayName || name);
      await refreshStandings();
      await reload();
    } catch (err) {
      show(err?.message || 'Kunde inte gå med.');
    } finally {
      setBusy(false);
    }
  };

  const watch = async () => {
    const name = viewerName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const res = await registerViewer(id, name);
      setViewer(id, true, res?.name || name, res?.token);
      setViewerState(true);
      setViewerNameSaved(res?.name || name);
      await reload();
    } catch (err) {
      show(err?.message || 'Kunde inte börja titta.');
    } finally {
      setBusy(false);
    }
  };

  const stopViewing = () => { setViewer(id, false); setViewerState(false); };

  const sendChat = async () => {
    const text = chatText.trim();
    const author = chatAuthor({ proxyHere, proxy, eventName, viewer, viewerNameSaved, canManage });
    if (!text || !author) return;
    setChatText('');
    try {
      const msg = await postChat(id, author, text);
      if (msg) setChat((list) => (list.some((m) => m.id === msg.id) ? list : [...list, msg]));
    } catch (err) {
      show(err?.message || 'Kunde inte skicka.');
    }
  };

  const enableAlerts = async () => {
    try {
      await subscribeToPush(id);
      show('Aviseringar på.');
    } catch (err) {
      show(err?.message || 'Kunde inte aktivera aviseringar.');
    }
  };

  // ── Host actions (all refresh on success) ───────────────────────────────────
  const hostAction = async (fn, successMsg) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      if (successMsg) show(successMsg);
    } catch (err) {
      show(err?.message || 'Åtgärden misslyckades.');
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (activityId, status) => hostAction(() => setActivityStatus(activityId, status));
  const simulateActivity = (activityId) => hostAction(() => simulate(activityId));
  const simulateAll = () => hostAction(async () => {
    for (const a of event.activities || []) {
      // eslint-disable-next-line no-await-in-loop
      await simulate(a.id).catch(() => {});
    }
  }, 'Simulerade alla aktiviteter.');
  const removeActivity = (activityId) => hostAction(() => deleteActivity(activityId));
  const resetActivity = (activityId) => hostAction(() => resetResults(activityId), 'Aktiviteten återställd.');
  const resetAll = (status) => hostAction(() => setActivitiesStatus(id, status), 'Återställde aktiviteter.');

  const move = (activityId, delta) => {
    const list = [...(event.activities || [])].sort((a, b) => a.order - b.order);
    const i = list.findIndex((a) => a.id === activityId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    hostAction(() => reorderActivities(id, list.map((a) => a.id)));
  };

  if (loading) {
    return (<>{toast}<div className="card center muted"><span className="spinner" style={{ margin: '1rem auto' }} /></div></>);
  }
  if (notFound || !event) {
    return (
      <>
        {toast}
        <div className="card stack">
          <h1>Hittades inte</h1>
          <p className="muted">Inget evenemang med den koden eller id:t.</p>
          <Link className="btn" to="/events">Tillbaka till evenemang</Link>
        </div>
      </>
    );
  }

  const activities = [...(event.activities || [])].sort((a, b) => a.order - b.order);
  const canChat = !!chatAuthor({ proxyHere, proxy, eventName, viewer, viewerNameSaved, canManage });
  const shareUrl = `${window.location.origin}/e/${event.id}`;

  // ── Reusable render blocks (composed per role below) ──────────────────────────
  // Logic is untouched; these are just the existing markup pieces, named so the
  // host / player / viewer flows can order them without duplication.

  const headerBlock = (
    <div className="card stack">
      <div className="row">
        {eventUnderway ? (
          <h1 className="grow" style={{ margin: 0 }}>
            <button
              type="button"
              onClick={() => setInfoOpen((v) => !v)}
              aria-expanded={infoOpen}
              style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}
            >
              <span className="grow">{event.name}</span>
              <span aria-hidden>{infoOpen ? '⌄' : '›'}</span>
            </button>
          </h1>
        ) : (
          <h1 className="grow" style={{ margin: 0 }}>{event.name}</h1>
        )}
        {reconnecting ? <Pill>Återansluter…</Pill> : null}
      </div>

      {event.imageUrl ? <img src={event.imageUrl} alt="" className="media-img" style={{ borderRadius: 'var(--radius-sm)' }} /> : null}

      {(!eventUnderway || infoOpen) ? (
        <div className="stack">
          {event.description ? <div className="rte-content" dangerouslySetInnerHTML={richHtml(event.description)} /> : null}
          <div className="row wrap muted small" style={{ alignItems: 'center' }}>
            <span>Evenemangskod <b style={{ letterSpacing: '0.08em' }}>{event.joinCode}</b></span>
            <span>·</span>
            <span>Lag om {event.teamSize}</span>
            {scheduleText(event) ? (<><span>·</span><span>📅 {scheduleText(event)}</span></>) : null}
            <button type="button" className="btn ghost sm" onClick={() => copyText(shareUrl, show, 'Länk kopierad.')}>Kopiera kod</button>
            <button type="button" className="btn ghost sm" onClick={() => setShareOpen(true)}>Dela</button>
          </div>
        </div>
      ) : null}

      {!eventOpenForMe ? (
        <div className="card" style={{ borderColor: 'var(--warn)', background: 'var(--surface-2)' }}>
          <span className="muted">{availabilityMessage(event)}</span>
        </div>
      ) : null}
    </div>
  );

  const finalResultsBlock = event.isComplete && standings && (standings.entries || []).length > 0 ? (
    <div className="card stack center">
      <Pill kind="ok">Slutresultat</Pill>
      <h2 style={{ margin: '.3rem 0' }}>{winnerLine(standings)}</h2>
      <p className="muted">{event.name} är klart — tack för att ni spelade!</p>
      <div className="row" style={{ justifyContent: 'center', gap: 14, flexWrap: 'wrap' }}>
        {(standings.entries || []).slice(0, 3).map((e) => (
          <div key={e.userId ?? e.displayName} className="center">
            <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>{e.rank}</div>
            <div>{e.displayName}</div>
            <div className="muted">{num(e.totalPoints)} p</div>
          </div>
        ))}
      </div>
      <Link className="btn sm block" to={`/diploma/${id}`}>🏆 Öppna vinnardiplomet</Link>
    </div>
  ) : null;

  const standingsBlock = (
    <div className="card">
      <h2>{event.isComplete ? 'Slutställning' : 'Totalställning'}</h2>
      <p className="muted small" style={{ marginTop: '-.4rem' }}>
        Poängen från alla spel räknas ihop här —{' '}
        {event.scoring === EventScoring.Placement
          ? 'placeringspoäng, varje avslutad aktivitet ger poäng efter placering.'
          : 'kumulativa poäng, varje lags faktiska poäng räknas ihop.'}
      </p>
      {!standings || (standings.entries || []).length === 0 ? (
        <p className="muted center">Inga poäng ännu — de räknas ihop över alla aktiviteter.</p>
      ) : (
        <table className="board">
          <tbody>
            {standings.entries.map((e) => (
              <tr key={e.userId ?? e.displayName} className={isMe(e.displayName) ? 'me' : undefined}>
                <td className="rank">{e.rank}</td>
                <td>
                  <b>{e.displayName}{isMe(e.displayName) ? <span className="muted"> · Du</span> : null}</b>
                  <div className="muted small">{e.activitiesPlayed} av {activities.length} aktiviteter</div>
                </td>
                {event.slapMode !== SlapMode.Off ? (
                  <td className="small" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <div style={{ color: 'var(--danger)' }}>{e.slapLost > 0 ? `−${num(e.slapLost)}` : '—'}</div>
                    <div style={{ color: 'var(--ok)' }}>{e.slapReceived > 0 ? `+${num(e.slapReceived)}` : '—'}</div>
                  </td>
                ) : null}
                <td className="pts">{num(e.totalPoints)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {event.slapMode !== SlapMode.Off && Object.keys(slapByActivity).length > 0 ? (
        <div className="stack" style={{ marginTop: '.8rem' }}>
          <h3 style={{ margin: 0 }}>Nyp att göra</h3>
          {Object.entries(slapByActivity).map(([actId]) => (
            <SlapCeremony key={actId} eventId={id} activityId={actId} onResolved={async () => { await reload(); }} />
          ))}
        </div>
      ) : null}
    </div>
  );

  const chatBlock = (
    <div className="card stack">
      <div className="row">
        <h2 className="grow">Chatt</h2>
        {hasWebPush && isPushSupported() ? (
          <button type="button" className="btn ghost sm" onClick={enableAlerts}>🔔 Aviseringar</button>
        ) : null}
      </div>
      <p className="muted small" style={{ marginTop: '-.4rem' }}>Prata med alla i evenemanget.</p>
      <div style={{ maxHeight: '16rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '.45rem' }}>
        {chat.length === 0 ? (
          <p className="muted center" style={{ margin: 0 }}>Inga meddelanden än — säg hej! 👋</p>
        ) : (
          chat.map((m) => (
            <div key={m.id} style={{ fontSize: '.9rem' }}>
              <b>{m.author}</b>{' '}
              <span className="muted small">{new Date(m.createdUtc).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}</span>
              <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</div>
            </div>
          ))
        )}
      </div>
      {canChat ? (
        <div className="row">
          <input
            type="text"
            className="grow"
            placeholder="Meddela alla…"
            maxLength={1000}
            value={chatText}
            onChange={(e) => setChatText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') sendChat(); }}
          />
          <button type="button" className="btn sm" onClick={sendChat} disabled={!chatText.trim()}>Skicka</button>
        </div>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>Gå med i evenemanget för att chatta.</p>
      )}
    </div>
  );

  const viewersBlock = (event.viewers || []).length > 0 ? (
    <div className="card">
      <h3>Tittar nu ({event.viewers.length})</h3>
      <p className="muted">{event.viewers.join(', ')}</p>
    </div>
  ) : null;

  const activitiesBlock = (
    <div className="card">
      <h2>Aktiviteter</h2>
      <p className="muted small" style={{ marginTop: '-.4rem' }}>Spelen i evenemanget — i tur och ordning.</p>
      {(() => {
        const located = activities.filter((a) => a.hasLocation);
        if (located.length === 0) return null;
        const avgLat = located.reduce((s, a) => s + a.latitude, 0) / located.length;
        const avgLng = located.reduce((s, a) => s + a.longitude, 0) / located.length;
        const markers = located.map((a) => ({
          lat: a.latitude,
          lng: a.longitude,
          label: `${a.order}. ${a.title}`,
          color: a.status === ActivityStatus.Finished ? '#16a34a' : a.status === ActivityStatus.Live ? '#f59e0b' : '#2563eb',
        }));
        const pins = coords ? [{ lat: coords.lat, lng: coords.lng }] : [];
        return <MapView center={[avgLat, avgLng]} markers={markers} pins={pins} fitToMarkers height="260px" />;
      })()}
      {activities.length === 0 ? (
        <p className="muted">Inga aktiviteter ännu{canManage ? ' — lägg till den första i värdkontrollerna.' : '.'}</p>
      ) : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 14 }}>
          {activities.map((a) => {
            const locked = a.hasLocation; // geofence is a nudge; treat located activities as "walk closer"
            return (
              <li key={a.id} className="stack" style={{ gap: '.55rem' }}>
                <div>
                  <b>{a.order}. {a.title}</b>
                  <div className="muted small">{typeLabel(a.type)}</div>
                </div>
                {a.imageUrl ? <img src={a.imageUrl} alt="" className="media-img" style={{ borderRadius: 'var(--radius-sm)' }} /> : null}
                <div className="row wrap">
                  <StatusBadge status={a.status} />
                  {a.status === ActivityStatus.Finished
                    || (eventOpenForMe && (a.status === ActivityStatus.Live || a.status === ActivityStatus.Open)) ? (
                      <Link className={`btn sm ${a.status === ActivityStatus.Live ? '' : 'ghost'}`} to={`/a/${a.id}`}>{actionLabel(a.status)}</Link>
                    ) : null}
                </div>
                {a.hasLocation ? (
                  <div className="row wrap small" style={{ gap: 6 }}>
                    <a className="btn ghost sm" href={`https://www.google.com/maps/dir/?api=1&destination=${a.latitude},${a.longitude}&travelmode=walking`} target="_blank" rel="noopener noreferrer">🗺️ Karta</a>
                    {locked && coords ? (
                      <span className="muted">Gå närmare · {Math.round(distanceMeters(coords.lat, coords.lng, a.latitude, a.longitude))} m</span>
                    ) : null}
                  </div>
                ) : null}
                {slapByActivity[a.id] ? (
                  <SlapCeremony eventId={id} activityId={a.id} onResolved={async () => { await reload(); }} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  const arrivalOverlay = arrivedId && activities.find((x) => x.id === arrivedId) ? (
    <ArrivalOverlay
      activity={activities.find((x) => x.id === arrivedId)}
      onGo={() => { const a = activities.find((x) => x.id === arrivedId); setArrivedId(null); navigate(`/a/${a.id}`); }}
      onDismiss={() => setArrivedId(null)}
    />
  ) : null;

  // Player identity surfaces — split out of one flat block so each role only
  // sees what's relevant (no competing "how do you want to join" cards).
  const joinedStatusBlock = eventName ? (
    <div className="card center muted">Du spelar som <b>{eventName}</b>.</div>
  ) : null;

  const viewerStatusBlock = (
    <div className="card stack center">
      <Pill>Åskådare</Pill>
      <p className="muted">Du tittar på {event.name} som <b>{viewerNameSaved}</b> — allt uppdateras live, men du tävlar inte.</p>
      <button type="button" className="btn block ghost" onClick={stopViewing} disabled={busy}>Gå med som spelare istället</button>
    </div>
  );

  // The full join card for a player who hasn't joined yet: ONE primary path,
  // with the free-name alternative + "bara titta" demoted to small options.
  const playerJoinBlock = (
    <>
      {user && !event.hasRoster ? (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Spela som dig själv</h2>
          <p className="muted" style={{ margin: 0 }}>
            Du är inloggad som <b>{user.displayName || user.username}</b> — dina poäng sparas.
          </p>
          <button type="button" className="btn block" onClick={claimAsMe} disabled={busy}>Spela som mig</button>
          <details>
            <summary style={{ cursor: 'pointer' }} className="muted small">…eller gå med med ett annat namn</summary>
            <div className="stack" style={{ marginTop: '.6rem' }}>
              <input type="text" maxLength={60} placeholder="Ditt namn" value={joinName} onChange={(e) => setJoinName(e.target.value)} />
              <button type="button" className="btn block ghost" onClick={joinFreeName} disabled={busy || !joinName.trim()}>Gå med i evenemanget</button>
            </div>
          </details>
        </div>
      ) : event.hasRoster ? (
        <div className="card stack">
          <h2>Vem är du?</h2>
          <p className="muted">Tryck på ditt namn för att gå med.</p>
          {user ? (
            <button type="button" className="btn block" onClick={claimAsMe} disabled={busy}>Spela som mig ({user.displayName || user.username})</button>
          ) : null}
          {(event.members || []).map((m) => (
            <button key={m.id} type="button" className="btn block ghost" onClick={() => claim(m.id)} disabled={busy}>{m.name}</button>
          ))}
        </div>
      ) : (
        <div className="card stack">
          <h2>Gå med i ”{event.name}”</h2>
          <p className="muted">Välj ett namn — du använder det för alla aktiviteter.</p>
          <input type="text" maxLength={60} placeholder="Ditt namn" value={joinName} onChange={(e) => setJoinName(e.target.value)} />
          <button type="button" className="btn block" onClick={joinFreeName} disabled={busy || !joinName.trim()}>Gå med i evenemanget</button>
        </div>
      )}

      {/* "Bara titta?" — small secondary option, not a co-equal card. */}
      <details className="card">
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Bara titta?</summary>
        <div className="stack" style={{ marginTop: '.6rem' }}>
          <p className="muted" style={{ margin: 0 }}>Följ allt live utan att tävla.</p>
          <input type="text" maxLength={60} placeholder="Ditt namn" value={viewerName} onChange={(e) => setViewerName(e.target.value)} />
          <button type="button" className="btn ghost block" onClick={watch} disabled={busy || !viewerName.trim()}>Titta som åskådare</button>
        </div>
      </details>
    </>
  );

  // The "play" group, shared by every role (it's where standings + games +
  // chat live during play).
  const playGroup = (
    <>
      {standingsBlock}
      {activitiesBlock}
      {chatBlock}
    </>
  );

  // ── Role-aware composition ────────────────────────────────────────────────────
  // HOST (canManage, not proxying): invite + manage first, play below.
  if (canManage && !proxyHere) {
    return (
      <>
        {toast}
        {headerBlock}
        {finalResultsBlock}

        {/* Host intro */}
        <div className="card stack">
          <div className="spread">
            <h2 style={{ margin: 0 }}>Värdläge</h2>
            <span className="pill accent">Bara du ser det här</span>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            Den här panelen är bara för dig som värd — bjud in spelare och styr spelen här. Spelarna ser sin
            egen vy: gå med, resultattavlan, aktiviteterna och chatten.
          </p>
          <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => togglePreview(true)}>
            👁 Förhandsgranska som spelare
          </button>
        </div>

        {/* Prominent, always-open invite */}
        <InviteFriends
          eventId={id}
          shareUrl={shareUrl}
          joinCode={event.joinCode}
          onToast={show}
          onReload={reload}
          onShare={() => setShareOpen(true)}
          onCopy={(text, msg) => copyText(text, show, msg)}
          anyBusy={busy}
        />

        {/* Run order + add activity + start/dry-run + players + details + reset */}
        <HostControls
          event={event}
          activities={activities}
          busy={busy}
          onSetStatus={setStatus}
          onMove={move}
          onSimulate={simulateActivity}
          onRemove={removeActivity}
          onReset={resetActivity}
          onSimulateAll={simulateAll}
          onResetAll={resetAll}
          onReload={reload}
          onToast={show}
        />

        {/* Optional: the host can also play. Small, secondary, no big join cards. */}
        {!eventName && !viewer ? (
          <div className="card stack">
            <h3 style={{ margin: 0 }}>Vill du också spela med?</h3>
            <p className="muted small" style={{ margin: 0 }}>Som värd kan du delta i tävlingen — dina poäng sparas.</p>
            <button type="button" className="btn block ghost" onClick={claimAsMe} disabled={busy}>Spela som mig</button>
          </div>
        ) : eventName ? joinedStatusBlock : viewer ? viewerStatusBlock : null}

        {viewersBlock}
        {playGroup}
        {arrivalOverlay}
        <QrShareModal open={shareOpen} url={shareUrl} title={`Gå med i ${event.name} — kod ${event.joinCode}`} onClose={() => setShareOpen(false)} />
      </>
    );
  }

  // ALREADY JOINED or VIEWER: small status line, then play.
  if (eventName || viewer) {
    return (
      <>
        {toast}
        {previewBanner}
        {headerBlock}
        {finalResultsBlock}
        {viewer ? viewerStatusBlock : joinedStatusBlock}
        {viewersBlock}
        {playGroup}
        {arrivalOverlay}
        <QrShareModal open={shareOpen} url={shareUrl} title={`Gå med i ${event.name} — kod ${event.joinCode}`} onClose={() => setShareOpen(false)} />
      </>
    );
  }

  // PLAYER ARRIVING (not host, not joined, not viewer): one clear join card, then play.
  return (
    <>
      {toast}
      {previewBanner}
      {headerBlock}
      {finalResultsBlock}
      {playerJoinBlock}
      {viewersBlock}
      {playGroup}
      {arrivalOverlay}
      <QrShareModal open={shareOpen} url={shareUrl} title={`Gå med i ${event.name} — kod ${event.joinCode}`} onClose={() => setShareOpen(false)} />
    </>
  );
}

// ── Host controls block ───────────────────────────────────────────────────────
function HostControls({
  event, activities, busy, onSetStatus, onMove, onSimulate, onRemove, onReset,
  onSimulateAll, onResetAll, onReload, onToast,
}) {
  const id = event.id;
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [newTitle, setNewTitle] = useState('');
  const [newType, setNewType] = useState(ActivityType.Quiz);
  const [localBusy, setLocalBusy] = useState(false);

  // Players & admins
  const [allUsers, setAllUsers] = useState([]);
  const [memberIds, setMemberIds] = useState(new Set((event.members || []).map((m) => m.id)));
  const [adminIds, setAdminIds] = useState(new Set(event.adminUserIds || []));
  const [coAdminIds, setCoAdminIds] = useState(new Set(event.coAdminIds || []));

  // Event details
  const [details, setDetails] = useState({
    name: event.name,
    description: event.description ?? '',
    teamSize: event.teamSize,
    scoring: event.scoring,
    teamShuffle: event.teamShuffle,
    slapMode: event.slapMode,
    startsAt: toLocalInput(event.startsAt),
    endsAt: toLocalInput(event.endsAt),
    code: event.joinCode,
  });
  const [fixedTeams, setFixedTeams] = useState(null);

  useEffect(() => {
    // The roster list lives on the People page; load it lazily for the picker.
    import('../api/users').then(({ listUsers }) => listUsers().then(setAllUsers).catch(() => {}));
    if (event.teamShuffle === TeamShuffle.FixedForEvent) {
      getTeams(id).then(setFixedTeams).catch(() => {});
    }
  }, [id, event.teamShuffle]);

  const addActivity = async () => {
    const title = newTitle.trim();
    if (!title) return;
    setLocalBusy(true);
    try {
      await createActivity({ title, type: newType, eventId: id });
      setNewTitle('');
      await onReload();
    } catch (err) {
      onToast(err?.message || 'Kunde inte lägga till aktivitet.');
    } finally {
      setLocalBusy(false);
    }
  };

  const toggleMember = (uid, on) => {
    setMemberIds((s) => { const n = new Set(s); if (on) n.add(uid); else { n.delete(uid); } return n; });
    if (!on) setAdminIds((s) => { const n = new Set(s); n.delete(uid); return n; });
  };
  const toggleAdmin = (uid, on) => setAdminIds((s) => { const n = new Set(s); if (on) n.add(uid); else n.delete(uid); return n; });

  const saveMembers = async () => {
    setLocalBusy(true);
    try {
      await setMembers(id, [...memberIds], [...adminIds]);
      await onReload();
      onToast('Spelare sparade.');
    } catch (err) {
      onToast(err?.message || 'Kunde inte spara spelare.');
    } finally {
      setLocalBusy(false);
    }
  };

  const saveDetails = async () => {
    setLocalBusy(true);
    try {
      await updateEvent(id, {
        name: details.name.trim(),
        description: details.description,
        teamSize: Number(details.teamSize),
        scoring: details.scoring,
        teamShuffle: details.teamShuffle,
        slapMode: details.slapMode,
        startsAt: details.startsAt ? new Date(details.startsAt).toISOString() : null,
        endsAt: details.endsAt ? new Date(details.endsAt).toISOString() : null,
      });
      await onReload();
      onToast('Evenemangsdetaljer sparade.');
    } catch (err) {
      onToast(err?.message || 'Kunde inte spara.');
    } finally {
      setLocalBusy(false);
    }
  };

  const saveCoAdmins = async () => {
    setLocalBusy(true);
    try {
      await setCoAdmins(id, [...coAdminIds]);
      await onReload();
      onToast('Medvärdar sparade.');
    } catch (err) {
      onToast(err?.message || 'Kunde inte spara medvärdar.');
    } finally {
      setLocalBusy(false);
    }
  };

  const saveCode = async () => {
    setLocalBusy(true);
    try { await setEventCode(id, details.code.trim()); await onReload(); onToast('Kod sparad.'); }
    catch (err) { onToast(err?.message || 'Kunde inte spara koden.'); }
    finally { setLocalBusy(false); }
  };
  const regenerateCode = async () => {
    setLocalBusy(true);
    try { const ev = await setEventCode(id, null); setDetails((d) => ({ ...d, code: ev.joinCode })); await onReload(); }
    catch (err) { onToast(err?.message || 'Kunde inte byta kod.'); }
    finally { setLocalBusy(false); }
  };
  const shuffleTeams = async () => {
    setLocalBusy(true);
    try { setFixedTeams(await reshuffleTeams(id)); onToast('Lagen blandades.'); }
    catch (err) { onToast(err?.message || 'Kunde inte blanda lagen.'); }
    finally { setLocalBusy(false); }
  };

  const toggleArchive = async () => {
    setLocalBusy(true);
    try {
      await updateEvent(id, {
        name: event.name,
        isArchived: !event.isArchived,
      });
      await onReload();
      onToast(event.isArchived ? 'Evenemanget återställt.' : 'Evenemanget arkiverat.');
    } catch (err) {
      onToast(err?.message || 'Kunde inte arkivera.');
    } finally {
      setLocalBusy(false);
    }
  };

  const anyBusy = busy || localBusy;

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Värdkontroller</h2>

      {/* Run order */}
      {activities.map((a, i) => (
        <div key={a.id} className="stack" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '.55rem', gap: '.45rem' }}>
          <div className="row">
            <span className="grow"><b>{a.order}. {a.title}</b></span>
            <button type="button" className="btn sm ghost" title="Flytta upp" onClick={() => onMove(a.id, -1)} disabled={anyBusy || i === 0}>↑</button>
            <button type="button" className="btn sm ghost" title="Flytta ner" onClick={() => onMove(a.id, 1)} disabled={anyBusy || i === activities.length - 1}>↓</button>
          </div>
          <div className="row wrap">
            {hostActions(a.status).map(([label, status]) => (
              <button
                key={label}
                type="button"
                className="btn sm success"
                onClick={() => onSetStatus(a.id, status)}
                disabled={anyBusy || (status === ActivityStatus.Live && event.pendingSlap && event.pendingSlap.activityId !== a.id)}
              >
                {label}
              </button>
            ))}
            {a.status !== ActivityStatus.Draft ? (
              <button type="button" className="btn sm ghost" title="Pausa men behåll i evenemanget" onClick={() => onSetStatus(a.id, ActivityStatus.Draft)} disabled={anyBusy}>Pausa</button>
            ) : null}
            <button type="button" className="btn sm soft" onClick={() => onSimulate(a.id)} disabled={anyBusy}>Simulera</button>
            {a.status !== ActivityStatus.Draft ? (
              <button type="button" className="btn sm ghost" onClick={() => onReset(a.id)} disabled={anyBusy}>Återställ</button>
            ) : null}
          </div>
          <div className="row wrap">
            <StatusBadge status={a.status} />
            <Link className="btn sm ghost" to={`/manage/${a.id}`}>Redigera</Link>
            {confirmDeleteId === a.id ? (
              <>
                <button type="button" className="btn sm danger" onClick={() => { setConfirmDeleteId(null); onRemove(a.id); }} disabled={anyBusy}>Ta bort?</button>
                <button type="button" className="btn sm ghost" onClick={() => setConfirmDeleteId(null)}>Avbryt</button>
              </>
            ) : (
              <button type="button" className="btn sm ghost danger" onClick={() => setConfirmDeleteId(a.id)} disabled={anyBusy}>Ta bort</button>
            )}
          </div>
        </div>
      ))}

      {/* Add activity + dry run */}
      <details style={{ marginTop: '.5rem' }} open={!activities.some((a) => a.status !== ActivityStatus.Draft)}>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Lägg till aktivitet &amp; testkör</summary>
        <div className="stack" style={{ marginTop: '.5rem' }}>
          <h3 style={{ margin: 0 }}>Lägg till en aktivitet</h3>
          <input type="text" placeholder="Aktivitetstitel" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} maxLength={200} />
          <select value={newType} onChange={(e) => setNewType(Number(e.target.value))}>
            {HOST_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
          </select>
          <button type="button" className="btn block success" onClick={addActivity} disabled={anyBusy || !newTitle.trim()}>Lägg till i evenemanget</button>

          <h3 style={{ margin: '.5rem 0 0' }}>Testkör</h3>
          <p className="muted small">Simulera alla aktiviteter med slumpresultat för att granska tavlorna före det riktiga.</p>
          <div className="row wrap">
            <button type="button" className="btn sm soft" onClick={onSimulateAll} disabled={anyBusy}>Simulera alla</button>
          </div>
          <p className="muted small" style={{ marginTop: '.5rem' }}>
            Återställ alla aktiviteter till en status utan att röra poängen.
          </p>
          <div className="row wrap">
            <button type="button" className="btn sm ghost" onClick={() => onResetAll(ActivityStatus.Draft)} disabled={anyBusy}>Alla till utkast</button>
            <button type="button" className="btn sm ghost" onClick={() => onResetAll(ActivityStatus.Open)} disabled={anyBusy}>Alla till öppna</button>
          </div>
        </div>
      </details>

      {/* Players & admins */}
      <details>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Spelare &amp; evenemangsadmins{memberIds.size > 0 ? ` (${memberIds.size})` : ''}</summary>
        <div className="stack" style={{ marginTop: '.6rem' }}>
          <p className="muted">Välj spelare från rostret, och bocka <b>admin</b> för att göra någon till medvärd. Hantera rostret under <Link to="/admin/users">Personer</Link>.</p>
          {allUsers.length === 0 ? (
            <p className="muted">Inga personer i rostret ännu.</p>
          ) : (
            <>
              {allUsers.map((u) => (
                <div key={u.id} className="row">
                  <label className="row grow" style={{ fontWeight: 500 }}>
                    <input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={memberIds.has(u.id)} onChange={(e) => toggleMember(u.id, e.target.checked)} />
                    <span className="grow">{u.name}</span>
                  </label>
                  {memberIds.has(u.id) ? (
                    <label className="muted small" style={{ fontWeight: 500 }}>
                      <input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={adminIds.has(u.id)} onChange={(e) => toggleAdmin(u.id, e.target.checked)} /> admin
                    </label>
                  ) : null}
                </div>
              ))}
              <button type="button" className="btn block success" onClick={saveMembers} disabled={anyBusy}>Spara spelare</button>
            </>
          )}
        </div>
      </details>

      {/* Co-admins (account-level) */}
      <details>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Medvärdar</summary>
        <div className="stack" style={{ marginTop: '.6rem' }}>
          <p className="muted">Ge andra registrerade konton rätt att hantera det här evenemanget. Medvärdar kan ändra inställningar, styra aktiviteter och se allt du ser.</p>
          {allUsers.length === 0 ? (
            <p className="muted">Inga registrerade konton att lägga till.</p>
          ) : (
            <>
              {allUsers.map((u) => (
                <label key={u.id} className="row" style={{ fontWeight: 500 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto', minHeight: 'auto' }}
                    checked={coAdminIds.has(u.id)}
                    onChange={(e) => setCoAdminIds((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(u.id); else n.delete(u.id);
                      return n;
                    })}
                  />
                  <span className="grow">{u.name}</span>
                </label>
              ))}
              <button type="button" className="btn block success" onClick={saveCoAdmins} disabled={anyBusy}>Spara medvärdar</button>
            </>
          )}
        </div>
      </details>

      {/* Event details */}
      <details>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Evenemangsdetaljer</summary>
        <div className="stack" style={{ marginTop: '.6rem' }}>
          <div className="field">
            <label>Evenemangskod</label>
            <div className="row">
              <input type="text" className="grow" value={details.code} onChange={(e) => setDetails((d) => ({ ...d, code: e.target.value }))} maxLength={16} />
              <button type="button" className="btn sm" onClick={saveCode} disabled={anyBusy}>Spara</button>
              <button type="button" className="btn ghost sm" onClick={regenerateCode} disabled={anyBusy}>Ny</button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="ev-name">Namn</label>
            <input type="text" id="ev-name" value={details.name} onChange={(e) => setDetails((d) => ({ ...d, name: e.target.value }))} maxLength={80} />
          </div>
          <div className="row wrap">
            <div className="field grow">
              <label htmlFor="ev-start">Tillgänglig från</label>
              <input id="ev-start" type="datetime-local" value={details.startsAt} onChange={(e) => setDetails((d) => ({ ...d, startsAt: e.target.value }))} />
            </div>
            <div className="field grow">
              <label htmlFor="ev-end">Tillgänglig till</label>
              <input id="ev-end" type="datetime-local" value={details.endsAt} onChange={(e) => setDetails((d) => ({ ...d, endsAt: e.target.value }))} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="ev-team">Spelare per lag</label>
            <input id="ev-team" type="number" min={1} max={20} value={details.teamSize} onChange={(e) => setDetails((d) => ({ ...d, teamSize: e.target.value }))} style={{ width: 120 }} />
          </div>
          {Number(details.teamSize) > 1 ? (
            <div className="field">
              <label htmlFor="ev-shuffle">Lag</label>
              <select id="ev-shuffle" value={details.teamShuffle} onChange={(e) => setDetails((d) => ({ ...d, teamShuffle: Number(e.target.value) }))}>
                <option value={TeamShuffle.EveryActivity}>Blanda om varje aktivitet</option>
                <option value={TeamShuffle.FixedForEvent}>Fasta lag för hela evenemanget</option>
              </select>
              {details.teamShuffle === TeamShuffle.FixedForEvent ? (
                <div className="stack" style={{ marginTop: 8 }}>
                  {fixedTeams && (fixedTeams.teams || fixedTeams) ? (
                    <ul className="muted small" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                      {(fixedTeams.teams || fixedTeams).map((t, i) => (
                        <li key={t.id ?? i}>{t.displayName || t.name}: {(t.members || []).map((m) => m.name).join(', ')}</li>
                      ))}
                    </ul>
                  ) : null}
                  <button type="button" className="btn ghost sm" onClick={shuffleTeams} disabled={anyBusy}>Blanda lagen</button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="ev-scoring">Poängsättning</label>
            <select id="ev-scoring" value={details.scoring} onChange={(e) => setDetails((d) => ({ ...d, scoring: Number(e.target.value) }))}>
              <option value={EventScoring.Placement}>Placering</option>
              <option value={EventScoring.Cumulative}>Kumulativt</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="ev-slap">Nyp</label>
            <select id="ev-slap" value={details.slapMode} onChange={(e) => setDetails((d) => ({ ...d, slapMode: Number(e.target.value) }))}>
              <option value={SlapMode.Off}>Av</option>
              <option value={SlapMode.Vanish}>På — halvera en rivals ledning, poängen försvinner</option>
              <option value={SlapMode.SendToPlayer}>På — halvera en rivals ledning, ge poängen till någon</option>
              <option value={SlapMode.SlappedSends}>På — halvera en rivals ledning, den nypta skickar poängen vidare</option>
              <option value={SlapMode.Random}>På — slump (försvinner eller ges) varje aktivitet</option>
            </select>
          </div>
          <button type="button" className="btn block success" onClick={saveDetails} disabled={anyBusy || !details.name.trim()}>Spara evenemangsdetaljer</button>
          <button type="button" className="btn block ghost" onClick={toggleArchive} disabled={anyBusy} style={{ marginTop: '.5rem' }}>
            {event.isArchived ? 'Återställ från arkiv' : 'Arkivera evenemanget'}
          </button>
        </div>
      </details>
    </div>
  );
}

// ── Invite players (host) ─────────────────────────────────────────────────────
// The host's primary call to action: now an always-open, prominent card at the
// top of the host view (was a collapsed <details> near the bottom). Two ways to
// invite: paste emails (comma/newline separated) and/or tick friends from your
// friends list. Each invitee gets a roster identity + a magic link; the links are
// always returned (copyable) so the host can share them when email is off.
// Surfaces emailEnabled + a per-link QR, plus a "share the code" affordance for
// anonymous joiners. Logic (ensureFriends/send/parseEmails) is unchanged.
function InviteFriends({ eventId, shareUrl, joinCode, onToast, onReload, onShare, onCopy, anyBusy }) {
  const [emails, setEmails] = useState('');
  const [friends, setFriends] = useState(null);
  const [friendsError, setFriendsError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [qrUrl, setQrUrl] = useState(null);

  // Load the host's friends. The section is always open now, so load on mount
  // (the same lazy-once guard as before — calls the unchanged loader).
  const ensureFriends = () => {
    if (friends != null) return;
    getFriends()
      .then((list) => { setFriends(list); setFriendsError(null); })
      .catch((e) => { setFriends([]); setFriendsError(e?.message || 'Kunde inte ladda vänner.'); });
  };

  useEffect(() => { ensureFriends(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (idVal, on) =>
    setSelected((s) => { const n = new Set(s); if (on) n.add(idVal); else n.delete(idVal); return n; });

  const parseEmails = () =>
    emails
      .split(/[,\n;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((email) => ({ email }));

  const send = async () => {
    const invites = parseEmails();
    const accountIds = [...selected];
    if (invites.length === 0 && accountIds.length === 0) {
      onToast?.('Lägg till minst en e-post eller välj en vän.');
      return;
    }
    setBusy(true);
    try {
      const res = await inviteToEvent(eventId, { invites, accountIds });
      setResults(res.invited || []);
      setEmailEnabled(!!res.emailEnabled);
      setEmails('');
      setSelected(new Set());
      await onReload?.();
    } catch (err) {
      onToast?.(err?.message || 'Kunde inte skicka inbjudningar.');
    } finally {
      setBusy(false);
    }
  };

  const disabled = anyBusy || busy;

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Bjud in spelare</h2>
      <p className="muted" style={{ margin: 0 }}>
        Bjud in via e-post eller välj bland dina vänner — var och en får en länk som loggar in dem och tar dem hit.
        Eller dela bara koden/länken nedan så går de med utan konto.
      </p>

      {/* Share the code (anonymous joiners) */}
      <div className="card stack" style={{ background: 'var(--surface-2)', gap: 8 }}>
        <div className="row wrap" style={{ alignItems: 'center', gap: 8 }}>
          <span className="muted small">Evenemangskod</span>
          <b style={{ fontSize: '1.2rem', letterSpacing: '0.12em' }}>{joinCode}</b>
          <span className="grow" />
          <button type="button" className="btn ghost sm" onClick={() => onCopy?.(joinCode, 'Kod kopierad.')}>Kopiera kod</button>
          <button type="button" className="btn ghost sm" onClick={() => onCopy?.(shareUrl, 'Länk kopierad.')}>Kopiera länk</button>
          <button type="button" className="btn sm" onClick={() => onShare?.()}>Dela / QR</button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>Den som har koden eller länken kan gå med utan konto.</p>
      </div>

      <div className="stack" style={{ marginTop: '.2rem' }}>
        {/* By email */}
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="invite-emails">E-postadresser</label>
          <textarea
            id="invite-emails"
            rows={3}
            placeholder="anna@exempel.se, kalle@exempel.se"
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
          />
          <p className="muted small" style={{ margin: '4px 0 0' }}>Separera med komma eller radbrytning.</p>
        </div>

        {/* From friends */}
        <div className="stack" style={{ gap: 6 }}>
          <b>Dina vänner</b>
          {friendsError ? <p className="error-text" style={{ margin: 0 }}>{friendsError}</p> : null}
          {friends == null ? (
            <div className="center muted"><span className="spinner" style={{ margin: '.4rem auto' }} /></div>
          ) : friends.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              Inga vänner ännu. Lägg till några under <Link to="/profile">Min profil</Link>.
            </p>
          ) : (
            friends.map((f) => (
              <label key={f.id} className="row" style={{ fontWeight: 500 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto', minHeight: 'auto' }}
                  checked={selected.has(f.id)}
                  onChange={(e) => toggle(f.id, e.target.checked)}
                />
                <span className="grow">{f.name}</span>
              </label>
            ))
          )}
        </div>

        <button type="button" className="btn block success" onClick={send} disabled={disabled}>
          {busy ? 'Skickar…' : 'Skicka inbjudningar'}
        </button>

        {/* Results */}
        {results ? (
          <div className="stack" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            {!emailEnabled ? (
              <p className="muted small" style={{ margin: 0 }}>
                E-post är inte påslaget — kopiera länkarna nedan och skicka dem själv.
              </p>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>Inbjudningar skickade. Länkarna kan delas manuellt också.</p>
            )}
            {results.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>Inga inbjudningar att visa.</p>
            ) : (
              results.map((r, i) => (
                <InviteResultRow key={r.email || r.accountId || i} result={r} onShowQr={setQrUrl} onToast={onToast} />
              ))
            )}
          </div>
        ) : null}
      </div>
      <QrShareModal open={!!qrUrl} url={qrUrl || ''} title="Inbjudningslänk" onClose={() => setQrUrl(null)} />
    </div>
  );
}

function InviteResultRow({ result, onShowQr, onToast }) {
  const [copied, setCopied] = useState(false);
  if (!result.ok) {
    return (
      <div className="row small" style={{ color: 'var(--danger)' }}>
        <span className="grow">{result.email || result.accountId}</span>
        <span>{result.error || 'Misslyckades'}</span>
      </div>
    );
  }
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(result.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { onToast?.('Kunde inte kopiera — kopiera länken manuellt.'); }
  };
  return (
    <div className="stack" style={{ gap: 4, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
      <div className="row">
        <span className="grow"><b>{result.name || result.email}</b></span>
        {result.emailed ? <span className="pill ok small">Mejlad</span> : null}
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="muted small" style={{ wordBreak: 'break-all', flex: 1, minWidth: 0 }}>{result.link}</span>
        <button type="button" className="btn sm soft" onClick={copy}>{copied ? 'Kopierad!' : 'Kopiera'}</button>
        <button type="button" className="btn sm ghost" onClick={() => onShowQr(result.link)}>QR</button>
      </div>
    </div>
  );
}

function ArrivalOverlay({ activity, onGo, onDismiss }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onDismiss}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(10,15,30,.7)', display: 'grid',
        placeItems: 'center', padding: 16, zIndex: 300, textAlign: 'center', color: '#fff',
      }}
    >
      <div onClick={(e) => e.stopPropagation()} className="stack center">
        <div style={{ fontSize: '3rem' }}>✓</div>
        <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>Du är framme!</div>
        <div>{activity.order}. {activity.title}</div>
        <button type="button" className="btn block" onClick={onGo} style={{ marginTop: 12 }}>{actionLabel(activity.status)}</button>
      </div>
    </div>
  );
}

// ── Identity persistence helpers ──────────────────────────────────────────────
// Save the per-activity participant tokens + the roster user/member token a claim
// produced, so the device re-presents the right identity on each activity.
function persistClaim(eventId, res) {
  if (!res) return;
  saveEventUserId(eventId, res.userId);
  saveEventName(eventId, res.displayName);
  if (res.memberToken) setMemberToken(eventId, res.memberToken);
  for (const slot of res.slots || []) {
    if (slot.token) setParticipantToken(slot.activityId, slot.token);
  }
}
function persistJoin(eventId, res) {
  if (!res) return;
  for (const slot of res.slots || []) {
    if (slot.token) setParticipantToken(slot.activityId, slot.token);
  }
}

// Copy text to the clipboard (with a non-secure-context fallback) and toast.
// Pure UI helper for the "Kopiera kod"/share affordances — no app state.
async function copyText(text, toastFn, okMsg = 'Kopierad!') {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    toastFn?.(okMsg);
  } catch {
    toastFn?.('Kunde inte kopiera — kopiera manuellt.');
  }
}

// Who this device chats as: proxy → my event name → viewer name → "Värd" → "".
function chatAuthor({ proxyHere, proxy, eventName, viewer, viewerNameSaved, canManage }) {
  if (proxyHere && proxy?.name) return proxy.name;
  if (eventName) return eventName;
  if (viewer && viewerNameSaved) return viewerNameSaved;
  if (canManage) return 'Värd';
  return '';
}

// ── Availability / schedule text ──────────────────────────────────────────────
function availableNow(event) {
  if (!event) return false;
  const now = Date.now();
  if (event.startsAt && now < new Date(event.startsAt).getTime()) return false;
  if (event.endsAt && now > new Date(event.endsAt).getTime()) return false;
  return true;
}
function availabilityMessage(event) {
  const now = Date.now();
  if (event.startsAt && now < new Date(event.startsAt).getTime()) {
    return `Det här evenemanget öppnar ${new Date(event.startsAt).toLocaleString('sv-SE')}.`;
  }
  if (event.endsAt && now > new Date(event.endsAt).getTime()) {
    return 'Det här evenemanget har avslutats.';
  }
  return '';
}
function scheduleText(event) {
  const fmt = (d) => new Date(d).toLocaleString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  if (event.startsAt && event.endsAt) return `${fmt(event.startsAt)} – ${new Date(event.endsAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}`;
  if (event.startsAt) return `Från ${fmt(event.startsAt)}`;
  if (event.endsAt) return `Till ${fmt(event.endsAt)}`;
  return '';
}
function winnerLine(standings) {
  const winners = (standings.entries || []).filter((e) => e.rank === 1).map((e) => e.displayName);
  if (winners.length === 0) return 'Resultat';
  if (winners.length === 1) return `${winners[0]} vinner!`;
  return `${winners.slice(0, -1).join(', ')} & ${winners[winners.length - 1]} delar segern!`;
}
// datetime-local wants "YYYY-MM-DDTHH:mm" in local time.
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
