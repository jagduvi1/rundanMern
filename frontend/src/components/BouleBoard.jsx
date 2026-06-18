// BouleBoard — round-based / measured score entry plus a live board. Used by
// Boule-style measured games AND the generic ScoreGame (same machinery).
//
// The React port of rundan's BouleBoard.razor. A scorekeeper records a result per
// UNIT (team / standalone player / per-team member). A HOST (canManage) scores the
// whole roster from one device; a plain player scores only their own unit. For
// timed games each unit has its own stopwatch, whose start/stop is relayed over
// sockets so every watching device ticks from the same start.
//
// Props:
//   activity    : ActivityDto — { id, measurement, scoringMode, scoreEntryMode,
//                 roundCount, courts, courtLabel, eventId, ... }.
//   participant : ParticipantDto — the unit on THIS device (a player's own team).
//   participants: ParticipantDto[] — the activity roster (for a host on a
//                 standalone game with no generated teams).
//   canManage   : boolean — host: scores every unit + may delete scores.
//
// TeamDto (GET /activities/:id/teams): { activityId, participantId, name,
//   members:[{id,name}] }. ScoreEntryDto: { id, participantId, participantName,
//   userId?, userName?, round, points, note?, recordedUtc }.
import { useEffect, useRef, useState, useMemo } from 'react';
import { recordScore, getScores, deleteScore, getActivityTeams } from '../api/gameplay';
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

export default function BouleBoard({
  activity, participant, participants = [], canManage = false,
}) {
  const isPoints = activity.measurement === Measurement.Points;
  const measuresTime = activity.measurement === Measurement.TimeSeconds
    || activity.measuresTime === true;
  const measuresLength = activity.measurement === Measurement.Millimetres
    || activity.measuresLength === true;
  const perPlayer = activity.scoreEntryMode === ScoreEntryMode.PerPlayer;
  const unitSuffix = measuresTime ? 's' : measuresLength ? 'mm' : '';

  const canScore = canManage || participant != null;

  const [teams, setTeams] = useState([]);
  const [history, setHistory] = useState([]);
  const [round, setRound] = useState(1);
  const [pending, setPending] = useState({}); // key -> stepper / number value
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  // Per-unit stopwatch: local { start: ms|null, accum: sec } and remote start ms.
  const [sw, setSw] = useState({});
  const [remote, setRemote] = useState({});
  const [, setNowTick] = useState(0); // forces re-render while a clock runs
  const tickRef = useRef(null);
  const aliveRef = useRef(true);
  const swRef = useRef(sw);
  swRef.current = sw;

  const historyMaxRound = history.length > 0 ? Math.max(...history.map((s) => s.round)) : 1;
  const maxRound = perPlayer ? 1 : Math.max(Math.max(1, activity.roundCount || 1), historyMaxRound);

  // Fairness for uneven teams (per-player mode): every team gets as many RUNS as the
  // biggest team's player count, so a short-handed team's players take extra runs and
  // the team still produces as many scoring entries as a full team. Each team is
  // capped at that target. A `round` here is one player RUN.
  const targetRuns = useMemo(
    () => (perPlayer && teams.length > 0
      ? teams.reduce((m, t) => Math.max(m, (t.members || []).length), 1) : 1),
    [perPlayer, teams],
  );
  const runsByTeam = useMemo(() => {
    const m = new Map();
    for (const s of history) m.set(String(s.participantId), (m.get(String(s.participantId)) || 0) + 1);
    return m;
  }, [history]);
  const runsByPlayer = useMemo(() => {
    const m = new Map();
    for (const s of history) {
      const k = `${s.participantId}:${s.userId}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }, [history]);

  // ── The units to score ───────────────────────────────────────────────────────
  const units = useMemo(() => {
    if (teams.length > 0) {
      if (perPlayer) {
        const out = [];
        for (const t of teams) {
          for (const m of t.members || []) {
            out.push({ key: `${t.participantId}:${m.id}`, participantId: t.participantId, userId: m.id, name: `${t.name} · ${m.name}` });
          }
        }
        return out;
      }
      return teams.map((t) => ({ key: String(t.participantId), participantId: t.participantId, name: t.name }));
    }
    // No generated teams (standalone game): a host scores the full roster.
    if (canManage && (participants || []).length > 0) {
      return participants.map((p) => ({ key: String(p.id), participantId: p.id, name: p.displayName }));
    }
    if (participant) return [{ key: String(participant.id), participantId: participant.id, name: participant.displayName }];
    return [];
  }, [teams, perPlayer, participants, participant, canManage]);

  // A host keeps score for everyone; a plain player only for their own unit.
  const visibleUnits = useMemo(() => (
    canManage ? units : units.filter((u) => participant && String(u.participantId) === String(participant.id))
  ), [canManage, units, participant]);

  // ── Loaders ────────────────────────────────────────────────────────────────
  async function loadHistory() {
    try {
      const list = await getScores(activity.id);
      const arr = Array.isArray(list) ? list : [];
      if (aliveRef.current) {
        setHistory(arr);
        if (arr.length > 0) setRound((r) => Math.max(r, Math.max(...arr.map((s) => s.round))));
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
    setPending({});
    setSw({});
    setRemote({});
    setRound(1);
    loadHistory();
    // Persisted per-activity teams (event games); [] for standalone.
    if (activity.eventId) {
      getActivityTeams(activity.id)
        .then((rows) => { if (aliveRef.current) setTeams(Array.isArray(rows) ? rows : []); })
        .catch(() => { if (aliveRef.current) setTeams([]); });
    } else {
      setTeams([]);
    }
    return () => {
      aliveRef.current = false;
      if (tickRef.current) clearInterval(tickRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id]);

  // ── Sockets: refresh on ScoreboardUpdated + live per-unit timer relay ────────
  useEffect(() => {
    let socket = null;
    let alive = true;

    const onScoreboard = (dto) => {
      if (alive && dto && String(dto.activityId) === String(activity.id)) loadHistory();
    };
    const onTimerStarted = (t) => {
      if (!alive || !t || String(t.activityId) !== String(activity.id)) return;
      // Show a remote clock for this unit unless WE are timing it locally.
      if (swRef.current[t.key]?.start == null) {
        setRemote((r) => ({ ...r, [t.key]: new Date(t.startedUtc).getTime() }));
        ensureTicking();
      }
    };
    const onTimerStopped = (t) => {
      if (!alive || !t || String(t.activityId) !== String(activity.id)) return;
      setRemote((r) => { const n = { ...r }; delete n[t.key]; return n; });
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
  }, [activity.id]);

  // ── Ticking: re-render a few times/sec while any clock runs ──────────────────
  function ensureTicking() {
    if (tickRef.current) return;
    tickRef.current = setInterval(() => setNowTick((n) => n + 1), 250);
  }
  const anyLocalRunning = Object.values(sw).some((v) => v.start != null);
  const anyRemoteRunning = Object.keys(remote).length > 0;
  useEffect(() => {
    if (!anyLocalRunning && !anyRemoteRunning && tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    } else if ((anyLocalRunning || anyRemoteRunning) && !tickRef.current) {
      ensureTicking();
    }
  }, [anyLocalRunning, anyRemoteRunning]);

  // ── Per-unit stopwatch controls (relayed over the socket) ────────────────────
  const startStopwatch = (key) => {
    setSw((s) => ({ ...s, [key]: { start: Date.now(), accum: 0 } }));
    setPending((p) => ({ ...p, [key]: 0 }));
    ensureTicking();
    startTimer(activity.id, key);
  };
  const pauseStopwatch = (key) => {
    setSw((s) => {
      const cur = s[key]; if (!cur || cur.start == null) return s;
      const seg = Math.max(0, (Date.now() - cur.start) / 1000);
      return { ...s, [key]: { start: null, accum: (cur.accum || 0) + seg } };
    });
    stopTimer(activity.id, key);
  };
  const resumeStopwatch = (key) => {
    setSw((s) => ({ ...s, [key]: { ...(s[key] || { accum: 0 }), start: Date.now() } }));
    ensureTicking();
    startTimer(activity.id, key);
  };
  const stopStopwatch = (key) => {
    const cur = swRef.current[key] || { start: null, accum: 0 };
    const seg = cur.start != null ? Math.max(0, (Date.now() - cur.start) / 1000) : 0;
    const total = Math.min(Math.round((cur.accum || 0) + seg), 100000);
    setPending((p) => ({ ...p, [key]: total }));
    setSw((s) => { const n = { ...s }; delete n[key]; return n; });
    stopTimer(activity.id, key);
  };

  // ── Record / delete ──────────────────────────────────────────────────────────
  async function record(unit) {
    if (!canScore) return;
    const value = Number(pending[unit.key]) || 0;
    // A zero reading is never a real result — it would wipe a team's prior reading
    // (single-reading games deleteMany first) and can prematurely auto-finish a
    // team game with an all-zero board. Mirrors the .NET guard (points <= 0).
    if (!(value > 0)) return;
    // Per-player: each save is one RUN. While the team is under its target, a save
    // adds the next run; once the team is full it replaces the player's last run (so
    // they can still correct it without exceeding the cap).
    let runRound = round;
    if (perPlayer) {
      const teamRuns = runsByTeam.get(String(unit.participantId)) || 0;
      const playerRuns = runsByPlayer.get(`${unit.participantId}:${unit.userId}`) || 0;
      if (teamRuns < targetRuns) runRound = playerRuns + 1;
      else if (playerRuns > 0) runRound = playerRuns;
      else { setError('Laget har redan använt alla sina körningar.'); return; }
    }
    setBusy(true);
    setError(null);
    try {
      await recordScore(activity.id, {
        participantId: unit.participantId,
        userId: perPlayer ? unit.userId : undefined,
        round: perPlayer ? runRound : round,
        points: value,
      });
      setPending((p) => ({ ...p, [unit.key]: 0 }));
      setSw((s) => { const n = { ...s }; delete n[unit.key]; return n; });
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

  const adjust = (key, delta) =>
    setPending((p) => ({ ...p, [key]: Math.min(Math.max(0, (Number(p[key]) || 0) + delta), 99) }));
  const setNumber = (key, raw) => {
    const v = Number(String(raw).replace(',', '.'));
    setPending((p) => ({ ...p, [key]: Number.isFinite(v) ? Math.min(Math.max(0, v), 100000) : 0 }));
  };

  const fmtValue = (v) => {
    if (measuresTime) return `${num(v)} s`;
    if (measuresLength) return `${num(v)} mm`;
    return num(v);
  };

  const scoringHint =
    activity.scoringMode === ScoringMode.LowerWins ? 'Lägst vinner.'
      : activity.scoringMode === ScoringMode.ClosestToTarget ? 'Närmast målvärdet vinner.'
        : 'Högst vinner.';

  // Progress (host view): how many of the expected slots are recorded. Only
  // meaningful for an event with generated teams — a standalone game has no
  // well-defined expected count (mirrors the .NET Progress()/StructureNote gate).
  const expectedSlots = teams.length === 0
    ? 0
    : (perPlayer ? teams.length * targetRuns : units.length * maxRound);
  const recordedSlots = useMemo(() => {
    const seen = new Set();
    for (const s of history) {
      if (perPlayer) { if (s.userId) seen.add(`${s.participantId}:${s.userId}:${s.round}`); }
      else seen.add(`${s.participantId}:${s.round}`);
    }
    return seen.size;
  }, [history, perPlayer]);

  const elapsedOf = (key) => {
    const cur = sw[key];
    if (cur?.start != null) return (cur.accum || 0) + (Date.now() - cur.start) / 1000;
    if (cur?.accum > 0) return cur.accum;
    if (remote[key] != null) return (Date.now() - remote[key]) / 1000;
    return Number(pending[key]) || 0;
  };

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

        <div className="muted small">
          {perPlayer ? 'Ett resultat per spelare.' : `${maxRound} runda${maxRound === 1 ? '' : 'r'}.`}
          {activity.playersPerRound ? ` ${activity.playersPerRound} spelare per runda.` : ''} {scoringHint}
          {canManage && expectedSlots > 0 ? ` · ${recordedSlots}/${expectedSlots} registrerade.` : ''}
        </div>

        {perPlayer && targetRuns > 1 ? (
          <div className="muted small">
            Ojämna lag: varje lag får {targetRuns} körningar totalt. Ett lag med färre spelare
            låter en spelare köra flera gånger tills laget når {targetRuns} — så alla lag får
            lika många försök.
          </div>
        ) : null}

        {courts.length > 0 ? (
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="muted small">{activity.courtLabel || 'Banor'}:</span>
            {courts.map((c) => (<span key={c.id} className="pill">{c.name}</span>))}
          </div>
        ) : null}

        {error ? <div style={errorBox}>{error}</div> : null}

        {!canScore ? (
          <p className="muted" style={{ margin: 0 }}>Gå med i aktiviteten för att registrera ditt resultat.</p>
        ) : visibleUnits.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Ingen spelare på den här enheten ännu.</p>
        ) : (
          <div className="stack" style={{ gap: 0 }}>
            {visibleUnits.map((u) => {
              const running = sw[u.key]?.start != null;
              const paused = sw[u.key]?.start == null && (sw[u.key]?.accum || 0) > 0;
              const remoteRunning = remote[u.key] != null;
              const val = Number(pending[u.key]) || 0;
              // Per-player fairness: how many runs this player + their team have used,
              // and whether the team is full with no run left for this player.
              const teamRuns = perPlayer ? (runsByTeam.get(String(u.participantId)) || 0) : 0;
              const playerRuns = perPlayer ? (runsByPlayer.get(`${u.participantId}:${u.userId}`) || 0) : 0;
              const teamFull = perPlayer && targetRuns > 1 && teamRuns >= targetRuns && playerRuns === 0;
              return (
                <div key={u.key} className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: '.6rem', marginTop: '.6rem' }}>
                  <span className="grow">
                    <b>{u.name}</b>
                    {perPlayer && targetRuns > 1 ? (
                      <span className="muted small" style={{ marginLeft: 6 }}>
                        {playerRuns > 0 ? `· ${playerRuns} körning${playerRuns === 1 ? '' : 'ar'} ` : ''}
                        · lag {teamRuns}/{targetRuns}
                      </span>
                    ) : null}
                  </span>

                  {isPoints ? (
                    <div style={stepperWrap}>
                      <button type="button" style={stepBtn} onClick={() => adjust(u.key, -1)} disabled={val <= 0}>−</button>
                      <span style={stepValue}>{num(val)}</span>
                      <button type="button" style={stepBtn} onClick={() => adjust(u.key, 1)}>+</button>
                    </div>
                  ) : measuresTime ? (
                    <>
                      {running ? (
                        <>
                          <button className="btn ghost sm" onClick={() => pauseStopwatch(u.key)}>Pausa</button>
                          <button className="btn ghost sm" onClick={() => stopStopwatch(u.key)}>Stoppa</button>
                        </>
                      ) : paused ? (
                        <>
                          <button className="btn ghost sm" onClick={() => resumeStopwatch(u.key)}>Fortsätt</button>
                          <button className="btn ghost sm" onClick={() => stopStopwatch(u.key)}>Stoppa</button>
                        </>
                      ) : (
                        <button className="btn ghost sm" onClick={() => startStopwatch(u.key)} disabled={remoteRunning}>Starta</button>
                      )}
                      <span style={{
                        ...clockText,
                        color: running ? undefined : paused ? '#f59e0b' : remoteRunning ? '#16a34a' : 'var(--text-muted)',
                      }} title={remoteRunning ? 'Någon tar tid just nu' : paused ? 'Pausad' : undefined}>
                        {remoteRunning && !running && !paused ? '⏱ ' : ''}{clock(elapsedOf(u.key))}
                      </span>
                    </>
                  ) : (
                    <>
                      <input type="number" min="0" max="100000" step="any" value={val} onChange={(e) => setNumber(u.key, e.target.value)} style={{ width: 90 }} />
                      <span className="muted">{unitSuffix}</span>
                    </>
                  )}

                  <button
                    className="btn sm success"
                    onClick={() => record(u)}
                    disabled={busy || val <= 0 || teamFull || (measuresTime && (running || paused || remoteRunning))}
                    title={teamFull ? `Laget har redan kört ${targetRuns} gånger` : undefined}
                  >
                    {isPoints ? 'Lägg till' : 'Spara'}
                  </button>
                </div>
              );
            })}
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
          const rows = [];
          const byName = new Map();
          for (const s of history) {
            const name = s.userName || s.participantName || '—';
            if (!byName.has(name)) {
              const entry = { name, rounds: {}, total: 0 };
              byName.set(name, entry);
              rows.push(entry);
            }
            const p = byName.get(name);
            p.rounds[s.round] = (p.rounds[s.round] || 0) + s.points;
            p.total += s.points;
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
                  {rows.map((p) => (
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
                    <button type="button" onClick={() => setPendingDelete(s.id)} disabled={busy} title="Ta bort" style={deleteBtn}>✕</button>
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
