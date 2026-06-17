// Events — "/events" — the player-facing event picker (port of rundan's
// Events.razor). The brand logo and the menu both point here. Lists every active
// (player-visible) event; tap a card to jump in. Host CRUD lives on /admin.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listActiveEvents, listEvents, getStandings } from '../api/events';
import { getEventName } from '../utils/appState';
import { EventScoring, SlapMode } from '../config/enums';
import { num, richHtml, formatDistance, typeLabel, slapBlurb } from '../utils/format';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/Toast';
import StatusBadge from '../components/StatusBadge';
import Pill from '../components/Pill';

function EventCard({ ev, joinedName, winner, onEnter, me }) {
  const activities = [...(ev.activities || [])].sort((a, b) => a.order - b.order);
  const cta = ev.isComplete
    ? 'Se slutresultat'
    : joinedName ? `Fortsätt som ${joinedName}` : `Gå in i ${ev.name}`;
  // Shared-status (managers only — owner/coAdmins are redacted from players). Owner
  // sees "shared with N", a co-host sees "shared by {owner}".
  const coAdmins = ev.coAdmins || [];
  const iAmOwner = !!(me && ev.owner && ev.owner.email === me.email);
  const sharedLabel = ev.canManage && coAdmins.length > 0
    ? (iAmOwner ? `Delad med ${coAdmins.length}` : `Delad av ${ev.owner?.displayName || ev.owner?.username || 'någon'}`)
    : null;

  return (
    <div className="card stack">
      {ev.imageUrl ? <img src={ev.imageUrl} alt="" className="media-img" style={{ borderRadius: 'var(--radius-sm)' }} /> : null}
      <div className="row" style={{ gap: 8 }}>
        <h2 style={{ margin: 0 }} className="grow">{ev.name}</h2>
        {ev.canManage ? <Pill kind="accent">Värd</Pill> : null}
        {sharedLabel ? <span className="muted small">{sharedLabel}</span> : null}
      </div>

      {ev.isComplete ? (
        <div className="row" style={{ gap: 8 }}>
          <Pill kind="ok">Avslutad</Pill>
          {winner ? <span><b>Vinnare: {winner}</b></span> : null}
        </div>
      ) : null}

      {ev.description ? (
        <div className="rte-content muted" dangerouslySetInnerHTML={richHtml(ev.description)} />
      ) : null}

      <div className="row wrap muted small" style={{ gap: 6 }}>
        <span>{activities.length} aktivitet{activities.length === 1 ? '' : 'er'}</span>
        <span>·</span>
        <span>lag om {ev.teamSize}</span>
        <span>·</span>
        <span>{ev.scoring === EventScoring.Placement ? 'placeringspoäng' : 'kumulativa poäng'}</span>
        {ev.estimatedMeters != null ? (
          <>
            <span>·</span>
            <span>≈ {formatDistance(ev.estimatedMeters)} till fots</span>
          </>
        ) : null}
      </div>

      {ev.slapMode !== SlapMode.Off ? (
        <div className="row wrap" style={{ gap: 8 }}>
          <Pill kind="warn">Nyp på</Pill>
          <span className="muted small">Efter varje aktivitet {slapBlurb(ev.slapMode)}</span>
        </div>
      ) : null}

      {activities.length > 0 ? (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 6 }}>
          {activities.map((a) => (
            <li key={a.id} className="row" style={{ gap: 8 }}>
              <span className="grow">
                <b>{a.order}.</b> {a.title}
                <span className="muted small"> · {typeLabel(a.type)}</span>
              </span>
              <StatusBadge status={a.status} />
            </li>
          ))}
        </ul>
      ) : null}

      <button type="button" className="btn block success" onClick={() => onEnter(ev.id)}>{cta}</button>
    </div>
  );
}

export default function Events() {
  useDocumentTitle('Evenemang · Gamedo');
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast, show } = useToast();
  const [events, setEvents] = useState([]);
  const [archived, setArchived] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [names, setNames] = useState({});
  const [winners, setWinners] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, all] = await Promise.all([
          listActiveEvents(),
          user ? listEvents().catch(() => []) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setEvents(list);
        // Archived = events in the full list that are flagged isArchived.
        const activeIds = new Set(list.map((e) => e.id));
        setArchived(all.filter((e) => e.isArchived || !activeIds.has(e.id)));

        const nm = {};
        for (const ev of list) {
          const saved = getEventName(ev.id);
          if (saved) nm[ev.id] = saved;
        }
        setNames(nm);

        // Winners for completed events (best-effort, in parallel).
        const completed = list.filter((e) => e.isComplete);
        const results = await Promise.allSettled(completed.map((e) => getStandings(e.id)));
        if (cancelled) return;
        const win = {};
        results.forEach((r, i) => {
          if (r.status === 'fulfilled' && r.value) {
            const top = (r.value.entries || []).filter((e) => e.rank === 1).map((e) => e.displayName);
            if (top.length > 0) win[completed[i].id] = top.join(' & ');
          }
        });
        setWinners(win);
      } catch (err) {
        if (!cancelled) show(err?.message || 'Kunde inte ladda evenemang.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {toast}
      <div className="card stack center">
        <img src="/assets/gamedo-mark.svg" width={56} height={56} alt="" style={{ margin: '0 auto' }} />
        <h1>Evenemang</h1>
        <p className="muted">Varje dag på Gamedo — välj ett för att hoppa in.</p>
        {user ? (
          <button type="button" className="btn lg success" onClick={() => navigate('/create')}>+ Skapa evenemang</button>
        ) : null}
      </div>

      {loading ? (
        <div className="card center muted"><span className="spinner" style={{ margin: '1rem auto' }} /></div>
      ) : events.length === 0 ? (
        <div className="card stack">
          <h2>Inget inplanerat ännu</h2>
          <p className="muted">
            När din värd sätter upp en dag dyker den upp här. Har du en kod?
            Öppna menyn (uppe till vänster ☰) för att hoppa in.
          </p>
        </div>
      ) : (
        events.map((ev) => (
          <EventCard
            key={ev.id}
            ev={ev}
            joinedName={names[ev.id]}
            winner={winners[ev.id]}
            onEnter={(id) => navigate(`/e/${id}`)}
            me={user}
          />
        ))
      )}

      {user && archived.length > 0 ? (
        <div className="card stack">
          <button type="button" className="btn ghost block" onClick={() => setShowArchived((s) => !s)}>
            {showArchived ? '▾' : '▸'} Arkiverade ({archived.length})
          </button>
          {showArchived ? archived.map((ev) => (
            <EventCard
              key={ev.id}
              ev={ev}
              joinedName={names[ev.id]}
              winner={winners[ev.id]}
              onEnter={(id) => navigate(`/e/${id}`)}
              me={user}
            />
          )) : null}
        </div>
      ) : null}
    </>
  );
}
