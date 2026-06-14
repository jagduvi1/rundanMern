// Scoreboard — live ranked leaderboard for one activity.
//
// The React port of rundan's Scoreboard.razor, but self-contained: it loads the
// initial board (unless `initial` is supplied) and subscribes to the
// `ScoreboardUpdated` socket event for this activity, swapping the board in on
// every push (rows arrive already ranked server-side, so we never re-sort).
//
// Props:
//   initial               : ScoreboardDto | null — seed board (skip the fetch).
//   activityId            : string — which activity's board to load/subscribe to.
//   highlightParticipantId: string | null — the local player's id (the "me" row).
//
// ScoreboardDto: { activityId, type, status, scoringMode, totalQuestions,
//   entries: [{ participantId, displayName, rank, totalPoints, entries }], updatedUtc }
import { useEffect, useState } from 'react';
import { getScoreboard } from '../api/activities';
import { getSocket } from '../utils/socket';
import { ServerEvents } from '../config/socketEvents';
import { ActivityType } from '../config/enums';
import { ApiError } from '../api/client';
import Spinner from './Spinner';

// Whole numbers render plain (5), fractions trimmed to ≤2 decimals (5.5) — the
// port of rundan's Fmt.Num.
function fmtNum(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

const isQuestionGame = (type) =>
  type === ActivityType.Quiz || type === ActivityType.Tipspromenad || type === ActivityType.MusicQuiz;
const isMapPin = (type) => type === ActivityType.MapPin;

export default function Scoreboard({ initial = null, activityId, highlightParticipantId = null }) {
  const [board, setBoard] = useState(initial);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState(null);

  // Initial fetch (only when no board was handed in). Guarded against unmount.
  useEffect(() => {
    if (initial) {
      setBoard(initial);
      return undefined;
    }
    if (!activityId) return undefined;

    let alive = true;
    setLoading(true);
    setError(null);
    getScoreboard(activityId)
      .then((dto) => {
        if (alive) setBoard(dto);
      })
      .catch((e) => {
        // A missing board is not an error — just nothing to show yet.
        if (alive && !(e instanceof ApiError && e.status === 404)) {
          setError(e?.message || 'Kunde inte ladda poängtavlan.');
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activityId, initial]);

  // Live updates: swap the board whenever a push for THIS activity arrives.
  useEffect(() => {
    if (!activityId) return undefined;
    let socket = null;
    let alive = true;

    const onUpdate = (dto) => {
      if (alive && dto && String(dto.activityId) === String(activityId)) setBoard(dto);
    };

    getSocket().then((s) => {
      if (!alive) return;
      socket = s;
      s.on(ServerEvents.ScoreboardUpdated, onUpdate);
    });

    return () => {
      alive = false;
      if (socket) socket.off(ServerEvents.ScoreboardUpdated, onUpdate);
    };
  }, [activityId]);

  if (loading) {
    return (
      <div className="center muted" style={{ padding: '1rem' }}>
        <Spinner />
      </div>
    );
  }

  if (error) {
    return <p className="error-text center">{error}</p>;
  }

  const entries = board?.entries || [];
  if (entries.length === 0) {
    return <p className="muted center">Inga poäng än — de första poängen kommer snart.</p>;
  }

  const questionGame = isQuestionGame(board.type);
  const mapPin = isMapPin(board.type);
  const showAnswered = questionGame && board.totalQuestions > 0;

  return (
    <table className="board">
      <thead>
        <tr>
          <th className="rank">#</th>
          <th>Lag</th>
          {showAnswered ? <th>Svar</th> : null}
          <th className="pts">Poäng</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const me = highlightParticipantId != null
            && String(e.participantId) === String(highlightParticipantId);
          return (
            <tr key={e.participantId} className={me ? 'me' : undefined}>
              <td className="rank">{e.rank}</td>
              <td>
                <b>{e.displayName}</b>
                {me ? <span className="muted"> · Du</span> : null}
              </td>
              {showAnswered ? (
                <td className="muted small">
                  {e.entries} / {board.totalQuestions}
                </td>
              ) : null}
              <td className="pts">
                {fmtNum(e.totalPoints)}
                {mapPin ? ' km' : ''}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
