// SlapCeremony — the per-activity "slap" ritual shown once an activity finishes.
// The winning team's designated slapper picks a rival (halving their lead);
// depending on the mode the points vanish, go to a chosen player, or the slapped
// player passes them on. Renders the pending action, the awaiting-recipient
// hand-off, or the resolved outcome — and nothing at all when there's no slap.
//
// The React port of rundan's SlapCeremony.razor. Unlike the .NET version (which
// took the slap DTO + the acting user id as props) this self-contained port
// fetches the slap itself and derives the acting user from the device's claimed
// roster identity for the event (or the host's "playing as" proxy).
//
// Props:
//   eventId   : string — the slap's event (mutations are keyed by event id).
//   activityId: string — the finished activity (the slap GET is keyed by this).
//   onResolved: () => void — called after a successful take/skip/send so the
//               parent can refresh standings + re-fetch the slap.
//
// ActivitySlapDto: { eventId, activityId, activityTitle, state, effectiveMode,
//   winnerName, winnerUserIds:[], members:[{userId,name}], slapperUserId,
//   slapperName, slappedUserId, slappedName, recipientName, penalty }
import { useEffect, useState } from 'react';
import {
  getActivitySlap, performSlap, sendSlapPoints, skipSlap,
} from '../api/eventSocial';
import { getHostToken, ApiError } from '../api/client';
import { getEventUserId, getProxy } from '../utils/appState';
import { SlapState, SlapMode } from '../config/enums';
import { num } from '../utils/format';

// Who is acting on this device for THIS event: the host's proxy identity when
// they're playing as a roster player, otherwise the claimed roster user id.
function actingUserId(eventId) {
  const proxy = getProxy();
  if (proxy && String(proxy.eventId) === String(eventId) && proxy.userId != null) {
    return String(proxy.userId);
  }
  const uid = getEventUserId(eventId);
  return uid != null ? String(uid) : null;
}

// The playful per-mode blurb under "Slap time!".
function blurb(mode) {
  switch (mode) {
    case SlapMode.Vanish:
      return 'de kan nypa en rival och halvera deras ledning — de poängen försvinner. 💨';
    case SlapMode.SendToPlayer:
      return 'de kan nypa en rival och halvera deras ledning — och ge poängen till någon. 🎁';
    case SlapMode.SlappedSends:
      return 'de kan nypa en rival och halvera deras ledning — sedan skickar den nypta poängen vidare. 🔁';
    default:
      return 'de kan nypa en rival och halvera deras ledning. ✋';
  }
}

export default function SlapCeremony({ eventId, activityId, onResolved }) {
  const [slap, setSlap] = useState(null);
  const [target, setTarget] = useState(''); // selected slapped user id
  const [recipient, setRecipient] = useState(''); // selected recipient user id
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const acting = actingUserId(eventId);
  const canManage = !!getHostToken(); // host-authenticated devices may skip

  // Load (and reload when the activity changes).
  useEffect(() => {
    let alive = true;
    setError(null);
    getActivitySlap(activityId)
      .then((dto) => {
        if (alive) setSlap(dto);
      })
      .catch((e) => {
        if (alive && !(e instanceof ApiError && e.status === 404)) {
          setError(e?.message || 'Kunde inte ladda nypet.');
        }
      });
    return () => {
      alive = false;
    };
  }, [activityId]);

  if (!slap) return null;

  const members = slap.members || [];
  const winnerIds = (slap.winnerUserIds || []).map(String);

  // Slap a rival: anyone not on the winning team.
  const targets = () => members.filter((m) => !winnerIds.includes(String(m.userId)));
  // Recipients when SendToPlayer: not the acting user, not the chosen target.
  const recipients = () =>
    members.filter((m) => String(m.userId) !== String(acting) && String(m.userId) !== String(target));
  // SlappedSends recipients: not the slapped player, not the slapper.
  const sendTargets = () =>
    members.filter((m) => String(m.userId) !== String(slap.slappedUserId)
      && String(m.userId) !== String(slap.slapperUserId));

  const canSlap = acting != null && String(slap.slapperUserId) === String(acting);
  const isSlapped = acting != null && String(slap.slappedUserId) === String(acting);

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (onResolved) await onResolved();
    } catch (e) {
      setError(e?.message || 'Något gick fel.');
    } finally {
      setBusy(false);
    }
  }

  const doPerform = () => run(() =>
    performSlap(
      eventId,
      activityId,
      target,
      slap.effectiveMode === SlapMode.SendToPlayer ? recipient : undefined,
    ));
  const doSend = () => run(() => sendSlapPoints(eventId, activityId, recipient));
  const doSkip = () => run(() => skipSlap(eventId, activityId));

  // ── Pending: the winner takes the slap ──────────────────────────────────────
  if (slap.state === SlapState.Pending) {
    return (
      <div className="card stack" style={accentCard}>
        <h2 style={{ margin: 0 }}>Nyp-dags! ✋</h2>
        <p style={{ margin: 0 }}>
          <b>{slap.winnerName}</b> vann ”{slap.activityTitle}” — {blurb(slap.effectiveMode)}
        </p>

        {canSlap ? (
          <>
            {error ? <div style={errorBox}>{error}</div> : null}
            <div className="field">
              <label>Nyp en rival</label>
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Välj någon…</option>
                {targets().map((p) => (
                  <option key={p.userId} value={p.userId}>{p.name}</option>
                ))}
              </select>
            </div>
            {slap.effectiveMode === SlapMode.SendToPlayer ? (
              <div className="field">
                <label>Ge poängen till</label>
                <select value={recipient} onChange={(e) => setRecipient(e.target.value)}>
                  <option value="">Välj någon…</option>
                  {recipients().map((p) => (
                    <option key={p.userId} value={p.userId}>{p.name}</option>
                  ))}
                </select>
              </div>
            ) : null}
            <button
              className="btn block success"
              onClick={doPerform}
              disabled={
                busy
                || !target
                || (slap.effectiveMode === SlapMode.SendToPlayer && !recipient)
              }
            >
              Nyp! ✋
            </button>
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Väntar på att {slap.slapperName || slap.winnerName} tar nypet…
          </p>
        )}

        {canManage ? (
          <button className="btn ghost sm" onClick={doSkip} disabled={busy}>
            Hoppa över nypet (värd)
          </button>
        ) : null}
      </div>
    );
  }

  // ── AwaitingRecipient: the slapped player passes the points on ───────────────
  if (slap.state === SlapState.AwaitingRecipient) {
    return (
      <div className="card stack" style={accentCard}>
        <h2 style={{ margin: 0 }}>Nypet landade! 😮</h2>
        {isSlapped ? (
          <>
            <p style={{ margin: 0 }}>
              Du förlorade <b>{num(slap.penalty)}</b> poäng till {slap.slapperName}s nyp — skicka
              dem nu vidare till någon (inte dig själv, och inte {slap.slapperName}).
            </p>
            {error ? <div style={errorBox}>{error}</div> : null}
            <div className="field">
              <label>Ge poängen till</label>
              <select value={recipient} onChange={(e) => setRecipient(e.target.value)}>
                <option value="">Välj någon…</option>
                {sendTargets().map((p) => (
                  <option key={p.userId} value={p.userId}>{p.name}</option>
                ))}
              </select>
            </div>
            <button className="btn block success" onClick={doSend} disabled={busy || !recipient}>
              Skicka poängen vidare
            </button>
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            <b>{slap.slappedName}</b> blev nypt — väntar på att de skickar poängen vidare…
          </p>
        )}
      </div>
    );
  }

  // ── Taken: the resolved outcome ──────────────────────────────────────────────
  if (slap.state === SlapState.Taken) {
    return (
      <div className="card stack">
        <span style={finalBadge}>Nyp taget</span>
        <p style={{ margin: 0 }}>
          <b>{slap.slapperName}</b> nöp <b>{slap.slappedName}</b> — −{num(slap.penalty)} poäng.
          {slap.recipientName
            ? <> De gick till <b>{slap.recipientName}</b>.</>
            : ' De poängen försvann.'}
        </p>
      </div>
    );
  }

  // ── Skipped ──────────────────────────────────────────────────────────────────
  if (slap.state === SlapState.Skipped) {
    return (
      <div className="card muted">Nypet för ”{slap.activityTitle}” hoppades över.</div>
    );
  }

  // None → render nothing.
  return null;
}

const accentCard = {
  borderColor: 'var(--accent)',
  background: 'var(--accent-soft)',
};
const finalBadge = {
  alignSelf: 'flex-start',
  padding: '4px 10px',
  borderRadius: 999,
  background: 'var(--accent-soft)',
  color: 'var(--accent-dark)',
  fontWeight: 700,
  fontSize: '.8rem',
};
const errorBox = {
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm, 8px)',
  background: '#fee2e2',
  color: '#991b1b',
  fontWeight: 600,
};
