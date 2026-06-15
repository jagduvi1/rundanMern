// BouleBoard — round-based / measured score entry plus a live board. Used by
// Boule-style measured games AND the generic ScoreGame (same machinery). A
// scorekeeper (the host, or the player on this device) records a score per round;
// everyone watching sees the running board (and, for timed games, a live shared
// stopwatch relayed over sockets so all viewers tick from the same start).
//
// The React port of rundan's BouleBoard.razor, adapted to this stack's props:
// instead of a roster of participants it takes the single `participant` on this
// device (its own score entry) and the server-combined `canManage` flag. The
// board below shows every recorded score (from getScores), newest first.
//
// Props:
//   activity   : ActivityDto — { id, measurement, measuresTime, measuresLength,
//                scoringMode, scoreEntryMode, roundCount, courts, courtLabel, ... }.
//   participant: ParticipantDto — { id, displayName } (whose score is entered).
//   canManage  : boolean — host (server-combined upstream); may delete scores.
//
// ScoreEntryDto: { id, participantId, participantName, userId?, userName?, round,
//   points, note?, recordedUtc }
import { useEffect, useRef, useState } from 'react';
import { recordScore, getScores, deleteScore } from '../api/gameplay';
import { getSocket, startTimer, stopTimer } from '../utils/socket';
import { ServerEvents } from '../config/socketEvents';
import { Measurement, ScoringMode, ScoreEntryMode } from '../config/enums';
import { ApiError } from '../api/client';
import { num } from '../utils/format';
import ConfirmDialog from './ConfirmDialog';

// "m:ss".
function clock(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function BouleBoard({ activity, participant, canManage = false }) {
  const isPoints = activity.measurement === Measurement.Points;
  const measuresTime = activity.measurement === Measurement.TimeSeconds
    || activity.measuresTime === true;
  const measuresLength = activity.measurement === Measurement.Millimetres
    || activity.measuresLength === true;
  const perPlayer = activity.scoreEntryMode === ScoreEntryMode.PerPlayer;
  const unitSuffix = measuresTime ? 's' : measuresLength ? 'mm' : '';

  // The device may keep score if it's the host or it's the joined player.
  const canScore = canManage || participant != null;
  const key = participant ? String(participant.id) : 'me';

  const [history, setHistory] = useState([]);
  const [round, setRound] = useState(1);
  const [pending, setPending] = useState(0); // stepper / number-entry value
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  // Stopwatch state: this device's running start (ms) + remote scorekeepers'.
  const [swStart, setSwStart] = useState(null); // ms or null (local)
  const [swAccum, setSwAccum] = useState(0); // seconds accumulated across paused segments
  const [remoteStart, setRemoteStart] = useState(null); // Date ms or null
  const [, setNowTick] = useState(0); // forces re-render while a clock runs
  const tickRef = useRef(null);
  const aliveRef = useRef(true);

  const historyMaxRound = history.length > 0 ? Math.max(...history.map((s) => s.round)) : 1;
  const maxRound = perPlayer ? 1 : Math.max(Math.max(1, activity.roundCount || 1), historyMaxRound);

  // ── Load history ─────────────────────────────────────────────────────────────
  async function loadHistory() {
    try {
      const list = await getScores(activity.id);
      const arr = Array.isArray(list) ? list : [];
      if (aliveRef.current) {
        setHistory(arr);
        if (arr.length > 0) {
          setRound((r) => Math.max(r, Math.max(...arr.map((s) => s.round))));
        }
      }
    } catch (e) {
      if (aliveRef.current && !(e instanceof ApiError && e.status === 404)) {
        setError(e?.message || 'Kunde inte ladda poängen.');
      }
    }
  }

  useEffect(() => {
    aliveRef.current = true;
    setHistory([]);
    setPending(0);
    setRound(1);
    setSwStart(null);
    setSwAccum(0);
    loadHistory();
    return () => {
      aliveRef.current = false;
      if (tickRef.current) clearInterval(tickRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id]);

  // ── Sockets: refresh on ScoreboardUpdated + live timer relay ─────────────────
  useEffect(() => {
    let socket = null;
    let alive = true;

    const onScoreboard = (dto) => {
      if (alive && dto && String(dto.activityId) === String(activity.id)) loadHistory();
    };
    const onTimerStarted = (t) => {
      if (!alive || !t || String(t.activityId) !== String(activity.id)) return;
      if (String(t.key) !== key) {
        setRemoteStart(new Date(t.startedUtc).getTime());
        ensureTicking();
      }
    };
    const onTimerStopped = (t) => {
      if (!alive || !t || String(t.activityId) !== String(activity.id)) return;
      if (String(t.key) !== key) setRemoteStart(null);
    };

    getSocket().then((s) => {
      if (!alive) return;
      socket = s;
      s.on(ServerEvents.ScoreboardUpdated, onScoreboard);
      s.on(ServerEvents.TimerStarted, onTimerStarted);
      s.on(ServerEvents.TimerStopped, onTimerStopped);
    });

    return () => {
      alive = false;
      if (socket) {
        socket.off(ServerEvents.ScoreboardUpdated, onScoreboard);
        socket.off(ServerEvents.TimerStarted, onTimerStarted);
        socket.off(ServerEvents.TimerStopped, onTimerStopped);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id, key]);

  // ── Ticking: re-render a few times/sec while any clock runs ──────────────────
  function ensureTicking() {
    if (tickRef.current) return;
    tickRef.current = setInterval(() => {
      // Stop when nothing is running.
      setNowTick((n) => n + 1);
    }, 250);
  }
  // Tear the ticker down once no local/remote timer remains.
  useEffect(() => {
    if (swStart == null && remoteStart == null && tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    } else if ((swStart != null || remoteStart != null) && !tickRef.current) {
      ensureTicking();
    }
  }, [swStart, remoteStart]);

  // ── Stopwatch controls (local) — relays start/stop over the socket ───────────
  function startStopwatch() {
    setSwAccum(0);
    setPending(0);
    setSwStart(Date.now());
    ensureTicking();
    startTimer(activity.id, key);
  }
  function pauseStopwatch() {
    const seg = Math.max(0, (Date.now() - swStart) / 1000);
    setSwAccum((a) => a + seg);
    setSwStart(null);
    stopTimer(activity.id, key);
  }
  function resumeStopwatch() {
    setSwStart(Date.now());
    ensureTicking();
    startTimer(activity.id, key);
  }
  function stopStopwatch() {
    const seg = swStart != null ? Math.max(0, (Date.now() - swStart) / 1000) : 0;
    const total = Math.min(Math.round(swAccum + seg), 100000);
    setPending(total);
    setSwStart(null);
    setSwAccum(0);
    stopTimer(activity.id, key);
  }

  // ── Record / delete ──────────────────────────────────────────────────────────
  async function record() {
    if (!canScore || !participant) return;
    const value = pending;
    if (value < 0) return;
    setBusy(true);
    setError(null);
    try {
      await recordScore(activity.id, {
        participantId: participant.id,
        round: perPlayer ? 1 : round,
        points: value,
      });
      setPending(0);
      setSwStart(null);
      setSwAccum(0);
      await loadHistory();
    } catch (e) {
      setError(e?.message || 'Kunde inte registrera poängen.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    const id = pendingDelete;
    setPendingDelete(null);
    if (id == null) return;
    setBusy(true);
    setError(null);
    try {
      await deleteScore(activity.id, id);
      await loadHistory();
    } catch (e) {
      setError(e?.message || 'Kunde inte ta bort poängen.');
    } finally {
      setBusy(false);
    }
  }

  const adjust = (delta) => setPending((p) => Math.min(Math.max(0, p + delta), 99));
  const setNumber = (raw) => {
    const v = Number(String(raw).replace(',', '.'));
    setPending(Number.isFinite(v) ? Math.min(Math.max(0, v), 100000) : 0);
  };

  // Format a recorded value for display.
  const fmtValue = (v) => {
    if (measuresTime) return `${num(v)} s`;
    if (measuresLength) return `${num(v)} mm`;
    return num(v);
  };

  const scoringHint =
    activity.scoringMode === ScoringMode.LowerWins ? 'Lägst vinner.'
      : activity.scoringMode === ScoringMode.ClosestToTarget ? 'Närmast målvärdet vinner.'
        : 'Högst vinner.';

  const localElapsed = swAccum + (swStart != null ? (Date.now() - swStart) / 1000 : 0);
  const remoteElapsed = remoteStart != null ? (Date.now() - remoteStart) / 1000 : 0;
  const courts = activity.courts || [];

  return (
    <div className="stack">
      {/* ── Score entry ──────────────────────────────────────────────────────── */}
      <div className="card stack">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Registrera poäng</h2>
          {!perPlayer && maxRound > 1 ? (
            <div className="row" style={{ gap: '.4rem' }}>
              <span className="muted small">Runda av {maxRound}</span>
              <div style={stepperWrap}>
                <button type="button" style={stepBtn} onClick={() => setRound((r) => Math.max(1, r - 1))} disabled={round <= 1}>−</button>
                <span style={stepValue}>{round}</span>
                <button type="button" style={stepBtn} onClick={() => setRound((r) => Math.min(maxRound, r + 1))} disabled={round >= maxRound}>+</button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="muted small">{perPlayer ? 'Ett resultat per spelare.' : `${maxRound} runda${maxRound === 1 ? '' : 'r'}.`} {scoringHint}</div>

        {courts.length > 0 ? (
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="muted small">{activity.courtLabel || 'Banor'}:</span>
            {courts.map((c) => (
              <span key={c.id} className="pill">{c.name}</span>
            ))}
          </div>
        ) : null}

        {error ? <div style={errorBox}>{error}</div> : null}

        {!canScore ? (
          <p className="muted" style={{ margin: 0 }}>Gå med i aktiviteten för att registrera ditt resultat.</p>
        ) : !participant ? (
          <p className="muted" style={{ margin: 0 }}>Ingen spelare på den här enheten ännu.</p>
        ) : (
          <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: '.6rem' }}>
            <span className="grow"><b>{participant.displayName}</b></span>

            {isPoints ? (
              <div style={stepperWrap}>
                <button type="button" style={stepBtn} onClick={() => adjust(-1)} disabled={pending <= 0}>−</button>
                <span style={stepValue}>{num(pending)}</span>
                <button type="button" style={stepBtn} onClick={() => adjust(1)}>+</button>
              </div>
            ) : measuresTime ? (
              <>
                {swStart != null ? (
                  <>
                    <button className="btn ghost sm" onClick={pauseStopwatch}>Pausa</button>
                    <button className="btn ghost sm" onClick={stopStopwatch}>Stoppa</button>
                  </>
                ) : swAccum > 0 ? (
                  <>
                    <button className="btn ghost sm" onClick={resumeStopwatch}>Fortsätt</button>
                    <button className="btn ghost sm" onClick={stopStopwatch}>Stoppa</button>
                  </>
                ) : (
                  <button className="btn ghost sm" onClick={startStopwatch} disabled={remoteStart != null}>Starta</button>
                )}
                {swStart != null ? (
                  <span style={clockText}>{clock(localElapsed)}</span>
                ) : swAccum > 0 ? (
                  <span style={{ ...clockText, color: '#f59e0b' }} title="Pausad">{clock(swAccum)}</span>
                ) : remoteStart != null ? (
                  <span style={{ ...clockText, color: '#16a34a' }} title="Någon tar tid just nu">⏱ {clock(remoteElapsed)}</span>
                ) : (
                  <span style={{ ...clockText, color: 'var(--text-muted)' }}>{clock(pending)}</span>
                )}
              </>
            ) : (
              <>
                <input
                  type="number"
                  min="0"
                  max="100000"
                  step="any"
                  value={pending}
                  onChange={(e) => setNumber(e.target.value)}
                  style={{ width: 90 }}
                />
                <span className="muted">{unitSuffix}</span>
              </>
            )}

            <button
              className="btn sm success"
              onClick={record}
              disabled={busy || pending < 0 || (measuresTime && (swStart != null || swAccum > 0 || remoteStart != null))}
            >
              {isPoints ? 'Lägg till' : 'Spara'}
            </button>
          </div>
        )}
      </div>

      {/* ── Live history ─────────────────────────────────────────────────────── */}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Historik</h2>
        {history.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Inga poäng registrerade än.</p>
        ) : (() => {
          // Group scores by participant, then by round.
          const participants = [];
          const participantMap = new Map();
          for (const s of history) {
            const key = s.participantName || s.userName || '—';
            if (!participantMap.has(key)) {
              const entry = { name: key, rounds: {}, total: 0, entries: [] };
              participantMap.set(key, entry);
              participants.push(entry);
            }
            const p = participantMap.get(key);
            // Sum multiple entries per round (points-style games add per round).
            p.rounds[s.round] = (p.rounds[s.round] || 0) + s.points;
            p.total += s.points;
            p.entries.push(s);
          }
          const roundNums = [...new Set(history.map((s) => s.round))].sort((a, b) => a - b);
          const multiRound = roundNums.length > 1 || maxRound > 1;

          return multiRound ? (
            <div style={{ overflowX: 'auto' }}>
              <table className="board" style={{ fontSize: '.85rem' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Spelare</th>
                    {roundNums.map((r) => <th key={r} style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>R{r}</th>)}
                    <th style={{ textAlign: 'right' }}>Totalt</th>
                  </tr>
                </thead>
                <tbody>
                  {participants.map((p) => (
                    <tr key={p.name}>
                      <td><b>{p.name}</b></td>
                      {roundNums.map((r) => (
                        <td key={r} style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {p.rounds[r] != null ? (isPoints ? `${p.rounds[r] >= 0 ? '+' : ''}${num(p.rounds[r])}` : fmtValue(p.rounds[r])) : '—'}
                        </td>
                      ))}
                      <td style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                        {isPoints ? num(p.total) : fmtValue(p.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {[...history].sort((a, b) => (a.id < b.id ? 1 : -1)).map((s) => (
                <li key={s.id} className="row" style={{ borderBottom: '1px solid var(--border)', padding: '.4rem 0' }}>
                  <span className="grow">{s.userName || s.participantName || '—'}</span>
                  <b style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {isPoints ? `${s.points >= 0 ? '+' : ''}${num(s.points)}` : fmtValue(s.points)}
                  </b>
                  {canManage ? (
                    <button
                      type="button"
                      onClick={() => setPendingDelete(s.id)}
                      disabled={busy}
                      title="Ta bort"
                      style={deleteBtn}
                    >
                      ✕
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          );
        })()}
      </div>

      <ConfirmDialog
        open={pendingDelete != null}
        title="Ta bort poängen?"
        message="Det går inte att ångra."
        confirmLabel="Ta bort"
        cancelLabel="Avbryt"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

const stepperWrap = {
  display: 'inline-flex', alignItems: 'center', gap: 0,
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm, 8px)', overflow: 'hidden',
};
const stepBtn = {
  width: 40, height: 40, border: 'none', background: 'var(--surface)',
  color: 'var(--text)', fontSize: '1.3rem', cursor: 'pointer',
};
const stepValue = {
  minWidth: '2.5ch', textAlign: 'center', fontSize: '1.2rem', fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
};
const clockText = {
  fontVariantNumeric: 'tabular-nums', fontSize: '1.15rem', fontWeight: 600,
  minWidth: 64, textAlign: 'right',
};
const deleteBtn = {
  border: 'none', background: 'none', cursor: 'pointer',
  color: 'var(--danger)', padding: 0, fontSize: '.9rem',
};
const errorBox = {
  padding: '10px 12px', borderRadius: 'var(--radius-sm, 8px)',
  background: '#fee2e2', color: '#991b1b', fontWeight: 600,
};
