// BracketBoard — draw, display, and record results for a knockout tournament with
// an optional round-robin group stage feeding up to two seeded playoff brackets
// (A = championship, B = plate), each with a winners' and an optional consolation
// (losers') side. Host-only actions are gated by `canManage`.
//
// The React port of rundan's BracketBoard.razor.
//
// Props:
//   activity : ActivityDto — { id, useManualSeeding, useGroupStage, matchFormat,
//              bestOfSets, gamesToWinSet, groupMatchFormat, groupBestOfSets,
//              groupGamesToWinSet, tournamentScoring, ... }.
//   canManage: boolean — host (server-combined upstream): draw / seed / result / reset.
//
// BracketDto:        { activityId, drawn, complete, championName?, playoffBChampionName?,
//   hasGroupStage, groupStageComplete, groups:[GroupStandingDto], matches:[BracketMatchDto] }
// GroupStandingDto:  { groupIndex, rows:[{ teamId, name, played, won, lost, pointsFor,
//   pointsAgainst, diff, rank, advancesToPool }] }
// BracketMatchDto:   { id, pool, groupIndex?, side, round, slot, aId?, aName?, bId?,
//   bName?, winnerParticipantId?, isBye, courtName?, score?, ready, decided }
// TeamSeedDto:       { teamId, name, seed }
import { useEffect, useRef, useState } from 'react';
import {
  getBracket, getSeeds, setSeeds, drawBracket, recordBracketResult, resetBracket,
} from '../api/bracket';
import { getSocket } from '../utils/socket';
import { ServerEvents } from '../config/socketEvents';
import { BracketSide, MatchFormat, TournamentScoring } from '../config/enums';
import { ApiError } from '../api/client';
import ConfirmDialog from './ConfirmDialog';

export default function BracketBoard({ activity, canManage = false }) {
  const [bracket, setBracket] = useState(null);
  const [seeds, setSeedsState] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // Result-entry modal.
  const [resultMatch, setResultMatch] = useState(null);
  const [scoreA, setScoreA] = useState([]);
  const [scoreB, setScoreB] = useState([]);
  const [resultError, setResultError] = useState(null);

  const aliveRef = useRef(true);
  const seedsLoadedRef = useRef(false);

  // ── Load ──────────────────────────────────────────────────────────────────────
  async function load({ reloadSeeds = true } = {}) {
    try {
      const b = await getBracket(activity.id);
      if (aliveRef.current) setBracket(b);
      // Seed editor: host + manual seeding + not yet drawn. Never refetch seeds on a
      // background refresh, or it would wipe the host's in-progress drag order.
      if (
        canManage && activity.useManualSeeding && b && !b.drawn
        && (reloadSeeds || !seedsLoadedRef.current)
      ) {
        try {
          const s = await getSeeds(activity.id);
          if (aliveRef.current) {
            setSeedsState(Array.isArray(s) ? s : []);
            seedsLoadedRef.current = true;
          }
        } catch {
          if (aliveRef.current) setSeedsState([]);
        }
      }
    } catch (e) {
      if (aliveRef.current && !(e instanceof ApiError && e.status === 404)) {
        setError(e?.message || 'Kunde inte ladda turneringen.');
      }
    } finally {
      if (aliveRef.current) setLoaded(true);
    }
  }

  useEffect(() => {
    aliveRef.current = true;
    seedsLoadedRef.current = false;
    setLoaded(false);
    load({ reloadSeeds: true });
    return () => {
      aliveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id]);

  // Refresh the bracket on a scoreboard push (a result entered elsewhere) — but
  // DON'T refetch the seed order (preserves any in-progress drag ordering).
  useEffect(() => {
    let socket = null;
    let alive = true;
    const onScoreboard = (dto) => {
      if (alive && dto && String(dto.activityId) === String(activity.id)) {
        load({ reloadSeeds: false });
      }
    };
    getSocket().then((s) => {
      if (!alive) return;
      socket = s;
      s.on(ServerEvents.ScoreboardUpdated, onScoreboard);
    });
    return () => {
      alive = false;
      if (socket) socket.off(ServerEvents.ScoreboardUpdated, onScoreboard);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id]);

  // ── Selected match format (group matches may be shorter) ─────────────────────
  const selGroup = resultMatch != null && resultMatch.groupIndex != null;
  const selFormat = selGroup ? activity.groupMatchFormat : activity.matchFormat;
  const selBestOf = Math.max(1, selGroup ? activity.groupBestOfSets : activity.bestOfSets);
  const selGames = selGroup ? activity.groupGamesToWinSet : activity.gamesToWinSet;
  const rowCount = selFormat === MatchFormat.Sets ? selBestOf : 1;
  const setsToWin = Math.floor(selBestOf / 2) + 1;

  // The winner implied by the current inputs (mirrors the server rule), or null.
  function winnerId() {
    const m = resultMatch;
    if (!m) return null;
    if (selFormat === MatchFormat.Sets) {
      let a = 0;
      let b = 0;
      for (let i = 0; i < rowCount; i += 1) {
        const sa = Number(scoreA[i]) || 0;
        const sb = Number(scoreB[i]) || 0;
        if (sa > sb) a += 1;
        else if (sb > sa) b += 1;
      }
      if (a >= setsToWin) return m.aId;
      if (b >= setsToWin) return m.bId;
      return null;
    }
    const sa = Number(scoreA[0]) || 0;
    const sb = Number(scoreB[0]) || 0;
    if (sa === sb) return null;
    return sa > sb ? m.aId : m.bId;
  }

  const winner = winnerId();
  const winnerPreview = (() => {
    if (winner == null) return selFormat === MatchFormat.Sets ? 'Ange setställningarna' : 'Ange resultatet';
    const name = String(winner) === String(resultMatch.aId) ? resultMatch.aName : resultMatch.bName;
    return `Vinnare: ${name}`;
  })();

  function openResult(m) {
    setResultMatch(m);
    const group = m.groupIndex != null;
    const fmt = group ? activity.groupMatchFormat : activity.matchFormat;
    const best = Math.max(1, group ? activity.groupBestOfSets : activity.bestOfSets);
    const rows = fmt === MatchFormat.Sets ? best : 1;
    setScoreA(Array(rows).fill(0));
    setScoreB(Array(rows).fill(0));
    setResultError(null);
  }

  async function saveResult() {
    const m = resultMatch;
    if (!m || winnerId() == null) return;
    const sets = [];
    for (let i = 0; i < rowCount; i += 1) {
      const a = Number(scoreA[i]) || 0;
      const b = Number(scoreB[i]) || 0;
      // Skip unplayed trailing sets (0–0).
      if (a !== 0 || b !== 0) sets.push({ a, b });
    }
    setBusy(true);
    setResultError(null);
    try {
      const updated = await recordBracketResult(activity.id, m.id, sets);
      if (aliveRef.current) {
        setBracket(updated);
        setResultMatch(null);
      }
    } catch (e) {
      if (aliveRef.current) setResultError(e?.message || 'Kunde inte spara resultatet.');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  function moveSeed(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= seeds.length) return;
    setSeedsState((prev) => {
      const next = prev.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function draw() {
    setBusy(true);
    setError(null);
    try {
      if (activity.useManualSeeding && seeds.length > 1) {
        await setSeeds(activity.id, seeds.map((s) => s.teamId));
      }
      const b = await drawBracket(activity.id);
      if (aliveRef.current) setBracket(b);
    } catch (e) {
      if (aliveRef.current) setError(e?.message || 'Kunde inte lotta.');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  async function doReset() {
    setConfirmReset(false);
    setBusy(true);
    setError(null);
    try {
      const b = await resetBracket(activity.id);
      if (aliveRef.current) setBracket(b);
      seedsLoadedRef.current = false;
      if (canManage && activity.useManualSeeding) {
        try {
          const s = await getSeeds(activity.id);
          if (aliveRef.current) {
            setSeedsState(Array.isArray(s) ? s : []);
            seedsLoadedRef.current = true;
          }
        } catch { /* ignore */ }
      }
    } catch (e) {
      if (aliveRef.current) setError(e?.message || 'Kunde inte återställa.');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  // ── Derivations over the matches ──────────────────────────────────────────────
  const matches = bracket?.matches || [];
  const groupMatchesIn = (gi) =>
    matches.filter((m) => m.groupIndex === gi).sort((a, b) => a.round - b.round || a.slot - b.slot);
  const poolsPresent = () =>
    [...new Set(matches.filter((m) => m.groupIndex == null).map((m) => m.pool))].sort((a, b) => a - b);
  const poolRounds = (pool, side) =>
    [...new Set(matches.filter((m) => m.groupIndex == null && m.pool === pool && m.side === side).map((m) => m.round))]
      .sort((a, b) => a - b);
  const poolMatches = (pool, side, round) =>
    matches
      .filter((m) => m.groupIndex == null && m.pool === pool && m.side === side && m.round === round)
      .sort((a, b) => a.slot - b.slot);
  const poolHasLosers = (pool) =>
    matches.some((m) => m.groupIndex == null && m.pool === pool && m.side === BracketSide.Losers);
  const playable = () =>
    matches
      .filter((m) => m.ready && !m.decided)
      .sort((a, b) =>
        (a.groupIndex ?? 1000) - (b.groupIndex ?? 1000)
        || a.pool - b.pool || a.side - b.side || a.round - b.round || a.slot - b.slot);

  const poolLabel = (pool) =>
    bracket?.hasGroupStage ? (pool === 0 ? 'Slutspel A' : 'Slutspel B') : 'Utslagsspel';
  const stageTag = (m) =>
    m.groupIndex != null
      ? `Grupp ${m.groupIndex + 1}`
      : `${poolLabel(m.pool).replace('Slutspel ', '')}${m.side === BracketSide.Winners ? 'V' : 'F'}${m.round}`;

  const canPick = (m) => canManage && !busy && m.ready && !m.decided;
  const winnerName = (m) => (String(m.winnerParticipantId) === String(m.aId) ? m.aName : m.bName) || '—';

  function scoringLegend() {
    if (activity.tournamentScoring === TournamentScoring.Placement) {
      return 'Poäng: lagen rangordnas efter hur långt de gick och poängsätts på slutplaceringen.';
    }
    return bracket?.hasGroupStage
      ? 'Poäng: 1 per gruppvinst, 3 per vinst i Slutspel A, 2 per vinst i Slutspel B, 1 per tröstrundsvinst.'
      : 'Poäng: 3 per vinst på vinnarsidan, 1 per vinst i trösterundan.';
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="card stack">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>Turnering</h2>
        {canManage && bracket?.drawn ? (
          <button className="btn ghost sm danger" onClick={() => setConfirmReset(true)} disabled={busy}>
            Återställ
          </button>
        ) : null}
      </div>

      {error ? <div style={errorBox}>{error}</div> : null}

      {!loaded ? (
        <p className="muted" style={{ margin: 0 }}>Laddar…</p>
      ) : !bracket || !bracket.drawn ? (
        // ── Pre-draw: optional manual seeding, then draw ──
        <>
          {canManage && activity.useManualSeeding && seeds.length > 1 ? (
            <>
              <h3 style={{ margin: '.25rem 0' }}>Seeda lagen</h3>
              <p className="muted small" style={{ margin: 0 }}>
                Rangordna lagen (1 = topp).{' '}
                {activity.useGroupStage
                  ? 'Seedningen sprids över grupperna.'
                  : 'Bracketen byggs så toppseedet möter det lägsta.'}
              </p>
              <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {seeds.map((s, i) => (
                  <li key={s.teamId} className="row" style={{ borderBottom: '1px solid var(--border)', padding: '.35rem 0' }}>
                    <span style={seedBadge}>{i + 1}</span>
                    <span className="grow">{s.name}</span>
                    <button className="btn ghost sm" onClick={() => moveSeed(i, -1)} disabled={i === 0}>▲</button>
                    <button className="btn ghost sm" onClick={() => moveSeed(i, 1)} disabled={i === seeds.length - 1}>▼</button>
                  </li>
                ))}
              </ol>
            </>
          ) : null}

          {!bracket ? (
            <p className="muted" style={{ margin: 0 }}>Laddar…</p>
          ) : canManage ? (
            <button className="btn block success" onClick={draw} disabled={busy}>
              {activity.useGroupStage ? 'Lotta grupperna' : 'Lotta lagen'}
            </button>
          ) : (
            <p className="muted" style={{ margin: 0 }}>Väntar på att värden lottar matcherna.</p>
          )}
        </>
      ) : (
        // ── Drawn ──
        <>
          {bracket.hasGroupStage ? (
            <>
              <h3 style={{ margin: '.25rem 0' }}>Gruppspel</h3>
              {!bracket.groupStageComplete ? (
                <p className="muted small" style={{ margin: 0 }}>
                  Spela ut varje gruppmatch — slutspelet seedas automatiskt när alla är inne.
                </p>
              ) : null}
              {bracket.groups.map((g) => {
                const gm = groupMatchesIn(g.groupIndex);
                return (
                  <div className="stack" key={g.groupIndex} style={{ gap: '.4rem' }}>
                    <h4 style={{ margin: '.25rem 0' }}>Grupp {g.groupIndex + 1}</h4>
                    <table style={grpTable}>
                      <thead>
                        <tr>
                          <th>#</th><th style={{ textAlign: 'left' }}>Lag</th>
                          <th>S</th><th>V</th><th>F</th><th>+/−</th><th />
                        </tr>
                      </thead>
                      <tbody>
                        {g.rows.map((row) => (
                          <tr key={row.teamId}>
                            <td>{row.rank}</td>
                            <td style={{ textAlign: 'left' }}>{row.name}</td>
                            <td>{row.played}</td>
                            <td>{row.won}</td>
                            <td>{row.lost}</td>
                            <td>{row.diff > 0 ? '+' : ''}{row.diff}</td>
                            <td><AdvanceBadge pool={row.advancesToPool} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {gm.some((m) => !m.decided) ? (
                      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                        {gm.map((m) => (
                          <PickRow key={m.id} m={m} canPick={canPick(m)} onPick={() => openResult(m)} winnerName={winnerName} />
                        ))}
                      </ul>
                    ) : null}
                  </div>
                );
              })}
            </>
          ) : null}

          {poolsPresent().map((pool) => {
            const champ = pool === 0 ? bracket.championName : bracket.playoffBChampionName;
            return (
              <div className="stack" key={pool} style={{ gap: '.4rem' }}>
                <h3 style={{ margin: '.25rem 0' }}>{poolLabel(pool)}</h3>
                {champ ? (
                  <div style={successBox}>
                    {pool === 0 ? 'Mästare' : 'Plate-vinnare'}: <b>{champ}</b>
                  </div>
                ) : null}

                <h4 style={{ margin: '.25rem 0' }}>Vinnarsida</h4>
                <div style={bracketRow}>
                  {poolRounds(pool, BracketSide.Winners).map((r) => (
                    <div style={roundCol} key={`w${r}`}>
                      {poolMatches(pool, BracketSide.Winners, r).map((m) => (
                        <MatchCard key={m.id} m={m} canPick={canPick(m)} onPick={() => openResult(m)} />
                      ))}
                    </div>
                  ))}
                </div>

                {poolHasLosers(pool) ? (
                  <>
                    <h4 style={{ margin: '.25rem 0' }}>Tröstrunda</h4>
                    <div style={bracketRow}>
                      {poolRounds(pool, BracketSide.Losers).map((r) => (
                        <div style={roundCol} key={`l${r}`}>
                          {poolMatches(pool, BracketSide.Losers, r).map((m) => (
                            <MatchCard key={m.id} m={m} canPick={canPick(m)} onPick={() => openResult(m)} />
                          ))}
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            );
          })}

          {playable().length > 0 ? (
            <>
              <h3 style={{ margin: '.25rem 0' }}>Spelordning</h3>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {playable().map((m) => (
                  <li key={m.id} className="row" style={{ borderBottom: '1px solid var(--border)', padding: '.35rem 0' }}>
                    {m.courtName ? <span style={seedBadge}>{m.courtName}</span> : null}
                    <span className="grow">{m.aName || '—'} vs {m.isBye ? '(walkover)' : (m.bName || '—')}</span>
                    <span className="muted small">{stageTag(m)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <p className="muted" style={{ fontSize: '.8rem', margin: 0 }}>{scoringLegend()}</p>
        </>
      )}

      {/* ── Result-entry modal ─────────────────────────────────────────────────── */}
      {resultMatch ? (
        <div style={overlay} onClick={() => setResultMatch(null)} role="presentation">
          <div className="card stack" style={{ maxWidth: 440, width: '100%' }} onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h3 className="grow" style={{ margin: 0 }}>Ange resultat</h3>
              <button className="btn ghost sm" onClick={() => setResultMatch(null)}>Stäng</button>
            </div>
            <div className="row" style={{ fontWeight: 600 }}>
              <span className="grow">{resultMatch.aName || '—'}</span>
              <span className="muted">vs</span>
              <span className="grow" style={{ textAlign: 'right' }}>{resultMatch.bName || '—'}</span>
            </div>

            {selFormat === MatchFormat.Sets ? (
              <p className="muted" style={{ fontSize: '.8rem', margin: 0 }}>
                Bäst av {selBestOf} set · först till {selGames} tar ett set · {setsToWin} för att vinna matchen.
              </p>
            ) : null}

            {resultError ? <div style={errorBox}>{resultError}</div> : null}

            {Array.from({ length: rowCount }).map((_, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div className="row" key={i} style={{ alignItems: 'center', gap: '.5rem' }}>
                {selFormat === MatchFormat.Sets ? (
                  <span className="muted small" style={{ width: 52 }}>Set {i + 1}</span>
                ) : null}
                <input
                  className="grow" type="number" min="0" max="100" style={{ textAlign: 'center' }}
                  value={scoreA[i] ?? 0}
                  onChange={(e) => setScoreA((p) => p.map((v, j) => (j === i ? e.target.value : v)))}
                />
                <span className="muted">–</span>
                <input
                  className="grow" type="number" min="0" max="100" style={{ textAlign: 'center' }}
                  value={scoreB[i] ?? 0}
                  onChange={(e) => setScoreB((p) => p.map((v, j) => (j === i ? e.target.value : v)))}
                />
              </div>
            ))}

            <div className="row" style={{ alignItems: 'center' }}>
              <span className="grow muted" style={{ fontSize: '.9rem' }}>{winnerPreview}</span>
              <button className="btn success" onClick={saveResult} disabled={busy || winner == null}>
                Spara resultat
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmReset}
        title="Återställ turneringen?"
        message="Lottningen och alla resultat raderas. Det går inte att ångra."
        confirmLabel="Återställ"
        cancelLabel="Avbryt"
        danger
        onConfirm={doReset}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}

// A group → A/B advance badge.
function AdvanceBadge({ pool }) {
  if (pool == null) return null;
  const style = pool === 0
    ? { ...advBadge, background: '#dcfce7', color: '#166534' }
    : advBadge;
  return <span style={style}>{pool === 0 ? '→ A' : '→ B'}</span>;
}

// A compact pickable row (round-robin group matches).
function PickRow({ m, canPick, onPick, winnerName }) {
  return (
    <li className="row" style={{ borderBottom: '1px solid var(--border)', padding: '.35rem 0' }}>
      {m.courtName ? <span style={seedBadge}>{m.courtName}</span> : null}
      <span className="grow">{m.aName || '—'} vs {m.bName || '—'}</span>
      {m.decided ? (
        <span className="muted small">{winnerName(m)}{m.score ? ` · ${m.score}` : ''}</span>
      ) : canPick ? (
        <button className="btn sm success" onClick={onPick}>Ange</button>
      ) : null}
    </li>
  );
}

// A bracket match card (winners'/consolation tree).
function MatchCard({ m, canPick, onPick }) {
  const teamRow = (id, name) => {
    if (canPick && id != null) {
      return (
        <button type="button" className="btn ghost sm" style={teamPick} onClick={onPick}>
          {name || '—'}
        </button>
      );
    }
    const won = m.winnerParticipantId != null && String(m.winnerParticipantId) === String(id);
    const lost = m.decided && id != null && !won;
    const label = m.isBye && id == null ? '(walkover)' : (name || '—');
    return (
      <div style={{ ...teamCell, ...(won ? teamWin : lost ? teamLose : {}) }}>{label}</div>
    );
  };
  return (
    <div style={matchCard}>
      {m.courtName ? <div style={{ fontSize: '.7rem', color: 'var(--text-muted)' }}>{m.courtName}</div> : null}
      {teamRow(m.aId, m.aName)}
      {teamRow(m.bId, m.bName)}
      {m.score ? <div style={{ fontSize: '.74rem', color: 'var(--text-muted)', textAlign: 'center' }}>{m.score}</div> : null}
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────────
const grpTable = { width: '100%', borderCollapse: 'collapse', fontSize: '.85rem', textAlign: 'center' };
const bracketRow = { display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 4 };
const roundCol = { display: 'flex', flexDirection: 'column', gap: 12, justifyContent: 'space-around', minWidth: 150 };
const matchCard = {
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm, 8px)',
  padding: 6, display: 'flex', flexDirection: 'column', gap: 4, background: 'var(--surface)',
};
const teamCell = { padding: '6px 8px', borderRadius: 6, fontSize: '.85rem', background: 'var(--surface-2, #f1f5f9)' };
const teamWin = { background: '#dcfce7', color: '#166534', fontWeight: 700 };
const teamLose = { opacity: 0.55 };
const teamPick = { justifyContent: 'flex-start', textAlign: 'left', width: '100%' };
const seedBadge = {
  fontSize: '.7rem', fontWeight: 700, padding: '2px 6px', borderRadius: 6,
  background: 'var(--accent-soft)', color: 'var(--accent-dark)',
};
const advBadge = {
  fontSize: '.7rem', fontWeight: 700, padding: '2px 6px', borderRadius: 6,
  background: 'var(--surface-2, #f1f5f9)', color: 'var(--text)',
};
const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 60,
};
const successBox = {
  padding: '10px 12px', borderRadius: 'var(--radius-sm, 8px)',
  background: '#dcfce7', color: '#166534', fontWeight: 600,
};
const errorBox = {
  padding: '10px 12px', borderRadius: 'var(--radius-sm, 8px)',
  background: '#fee2e2', color: '#991b1b', fontWeight: 600,
};
