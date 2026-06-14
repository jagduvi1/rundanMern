// ResultsSummary — read-only per-question breakdown for a finished activity:
// every question with its correct answer and what each player gave.
//
// The React port of rundan's ResultsSummary.razor.
//
// Props:
//   activity : ActivityDto — { id, ... }.
//
// ActivitySummaryDto: { questions: [{ order, text, correct?, answers: [
//   { player, given, isCorrect, points } ] }] }
// (404 / not-ready / no-access → renders nothing.)
import { useEffect, useState } from 'react';
import { getSummary } from '../api/activities';
import Spinner from './Spinner';

export default function ResultsSummary({ activity }) {
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getSummary(activity.id)
      .then((dto) => {
        if (alive) setSummary(dto);
      })
      .catch(() => {
        // Not ready / no access — show nothing.
        if (alive) setSummary(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activity.id]);

  if (loading) {
    return (
      <div className="card center muted" style={{ padding: '1rem' }}>
        <Spinner />
      </div>
    );
  }

  const questions = summary?.questions || [];
  if (questions.length === 0) return null;

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Allas svar</h2>
      {questions.map((q) => (
        <div key={q.order} style={{ borderBottom: '1px solid var(--border)', padding: '.55rem 0' }}>
          <div style={{ marginBottom: '.15rem' }}>
            <b>{q.order}.</b> {q.text}
          </div>
          {q.correct && q.correct.trim() ? (
            <div className="muted small" style={{ marginBottom: '.25rem' }}>
              Svar: <b>{q.correct}</b>
            </div>
          ) : null}
          {(!q.answers || q.answers.length === 0) ? (
            <div className="muted small">Ingen svarade.</div>
          ) : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {q.answers.map((a, ai) => (
                <li
                  // eslint-disable-next-line react/no-array-index-key
                  key={ai}
                  className={`row ${a.isCorrect === false ? 'muted' : ''}`}
                  style={{ gap: 8 }}
                >
                  {a.isCorrect != null ? <span aria-hidden="true">{a.isCorrect ? '✓' : '✗'}</span> : null}
                  <span className="grow">
                    <b>{a.player}</b> — {a.given}
                  </span>
                  {a.points > 0 ? <span className="pill ok">+{a.points}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
