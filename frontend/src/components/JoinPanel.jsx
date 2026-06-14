// JoinPanel — name-entry to join a single activity (the lobby entry point).
//
// The React port of rundan's JoinPanel.razor. Reclaims an existing per-activity
// participant token (so the same device re-joins as the same player instead of
// creating a duplicate), persists the freshly issued token, then hands the
// participant + token back to the parent.
//
// Props:
//   activity : ActivityDto — must carry { id, title, joinCode, status }.
//   onJoined : (participant, token) => void — invoked after a successful join.
//
// When the activity is Open (not yet Live) we show a short "waiting for the host
// to start" lobby note beneath the form — joining is allowed, play isn't yet.
import { useState } from 'react';
import { joinActivity } from '../api/participants';
import { setParticipantToken, getParticipantToken, ApiError } from '../api/client';
import { ActivityStatus } from '../config/enums';

export default function JoinPanel({ activity, onJoined }) {
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const isOpen = activity?.status === ActivityStatus.Open;

  async function join() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Skriv ett namn först.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Re-present any token this device already holds for the activity so the
      // server reconnects us rather than minting a duplicate participant.
      const existingToken = getParticipantToken(activity.id) || undefined;
      const result = await joinActivity(activity.joinCode, trimmed, existingToken);
      setParticipantToken(activity.id, result.token);
      onJoined?.(result.participant, result.token);
    } catch (e) {
      // 409 = duplicate name (or activity not joinable). Surface the server's
      // message — it already explains "name taken, pick another".
      if (e instanceof ApiError && e.status === 409) {
        setError(e.message || 'Det namnet är upptaget — välj ett annat.');
      } else {
        setError(e?.message || 'Kunde inte gå med just nu.');
      }
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter') join();
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Gå med i ”{activity?.title}”</h2>
      <p className="muted" style={{ margin: 0 }}>Välj ett namn som dina vänner känner igen.</p>

      {error ? <div className="error-text">{error}</div> : null}

      <input
        type="text"
        maxLength={60}
        placeholder="Ditt namn"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={busy}
        autoFocus
      />

      <button className="btn block" onClick={join} disabled={busy}>
        {busy ? 'Går med…' : 'Gå med'}
      </button>

      {isOpen ? (
        <p className="muted small center" style={{ margin: 0 }}>
          ⏳ Väntar på att värden ska starta — du kan gå med redan nu.
        </p>
      ) : null}
    </div>
  );
}
