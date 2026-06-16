// ResultsView — final standings for a finished activity. Loads the (final)
// scoreboard, crowns the winner, shows medals for the podium, and — for
// question/music activities — offers a per-question breakdown (ResultsSummary).
//
// Props:
//   activity  : ActivityDto — { id, type, status, ... }.
//   session   : the joined player's participant (or null) — drives the personal
//               "Du: <answer> ✓/✗" reveal in the per-question breakdown.
//   canManage : host can correct the answer key from the breakdown.
//
// The board comes from getScoreboard (rows arrive already ranked). For a finished
// activity it is the final result; we still subscribe to ScoreboardUpdated in
// case a late host answer-key correction re-scores everyone.
import { useEffect, useState } from 'react';
import { getScoreboard } from '../api/activities';
import { getSocket } from '../utils/socket';
import { ServerEvents } from '../config/socketEvents';
import { ActivityType } from '../config/enums';
import { ApiError } from '../api/client';
import Spinner from './Spinner';
import AnswerReview from './AnswerReview';

function fmtNum(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

const isQuestionGame = (type) =>
  type === ActivityType.Quiz || type === ActivityType.Tipspromenad || type === ActivityType.MusicQuiz;
const isMapPin = (type) => type === ActivityType.MapPin;

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

export default function ResultsView({ activity, session = null, canManage = false }) {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Open the per-question facit by default for a host (they're here to correct).
  const [showBreakdown, setShowBreakdown] = useState(!!canManage);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    getScoreboard(activity.id)
      .then((dto) => {
        if (alive) setBoard(dto);
      })
      .catch((e) => {
        if (alive && !(e instanceof ApiError && e.status === 404)) {
          setError(e?.message || 'Kunde inte ladda resultatet.');
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activity.id]);

  // Pick up a late re-score from a host answer-key correction.
  useEffect(() => {
    let socket = null;
    let alive = true;
    const onUpdate = (dto) => {
      if (alive && dto && String(dto.activityId) === String(activity.id)) setBoard(dto);
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
  }, [activity.id]);

  if (loading) {
    return (
      <div className="card center muted" style={{ padding: '1.2rem' }}>
        <Spinner /> Laddar resultat…
      </div>
    );
  }

  const entries = board?.entries || [];
  const questionGame = isQuestionGame(activity.type);
  const mapPin = isMapPin(activity.type);
  const winner = entries.find((e) => e.rank === 1);

  return (
    <div className="stack">
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Slutresultat</h2>
        {error ? <div className="error-text">{error}</div> : null}

        {entries.length === 0 ? (
          <p className="muted center">Inga poäng registrerades.</p>
        ) : (
          <>
            {winner ? (
              <div
                className="center"
                style={{
                  padding: '14px',
                  borderRadius: 'var(--radius)',
                  background: 'linear-gradient(135deg,#fde68a,#fbbf24)',
                  color: '#7c2d12',
                }}
              >
                <div style={{ fontSize: '1.8rem' }}>🏆</div>
                <div style={{ fontWeight: 800, fontSize: '1.2rem' }}>{winner.displayName}</div>
                <div className="small">
                  vinner med {fmtNum(winner.totalPoints)}{mapPin ? ' km' : ' p'}
                </div>
              </div>
            ) : null}

            <table className="board">
              <thead>
                <tr>
                  <th className="rank">#</th>
                  <th>Lag</th>
                  <th className="pts">Poäng</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.participantId} className={e.rank === 1 ? 'me' : undefined}>
                    <td className="rank">{MEDALS[e.rank] || e.rank}</td>
                    <td><b>{e.displayName}</b></td>
                    <td className="pts">
                      {fmtNum(e.totalPoints)}
                      {mapPin ? ' km' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {questionGame ? (
          <button className="btn ghost block" onClick={() => setShowBreakdown((v) => !v)}>
            {showBreakdown ? 'Dölj facit & svar' : 'Visa facit & svar'}
          </button>
        ) : null}
      </div>

      {questionGame && showBreakdown ? (
        <AnswerReview activity={activity} session={session} canManage={canManage} />
      ) : null}
    </div>
  );
}
