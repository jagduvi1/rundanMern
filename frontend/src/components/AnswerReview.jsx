// AnswerReview — per-question facit for a finished Quiz/Tipspromenad. Port of the
// host-correction + personal-reveal half of rundan's ResultsView.razor (the part
// the MERN port had dropped):
//   • Host (canManage): tap an option to mark it correct, or edit the accepted
//     free-text answer — the server re-scores everyone automatically.
//   • Player (session): sees the correct answer, a "ditt val" badge on their pick,
//     and a "Du: <answer> ✓/✗" line.
//
// Sources: getResults (correct key + option ids) and, when a session exists,
// getMyAnswers (the viewer's own answers). After a correction we re-fetch both;
// the parent ResultsView's ScoreboardUpdated subscription refreshes the podium.
import { useEffect, useState, useCallback } from 'react';
import { getResults, setAnswerKey } from '../api/questions';
import { getMyAnswers } from '../api/gameplay';
import { QuestionKind } from '../config/enums';
import Spinner from './Spinner';

function displayMine(q, a) {
  if (q.kind === QuestionKind.FreeText) return a.freeText || a.artistText || '—';
  const opt = (q.options || []).find((o) => String(o.id) === String(a.selectedOptionId));
  return opt ? opt.text : 'ditt val';
}

export default function AnswerReview({ activity, session, canManage }) {
  const [results, setResults] = useState(null);
  const [mine, setMine] = useState({}); // questionId -> MyAnswerDto
  const [freeEdits, setFreeEdits] = useState({}); // questionId -> edited accepted text
  const [saving, setSaving] = useState(null); // questionId being saved
  const [error, setError] = useState(null);

  const loadMine = useCallback(() => {
    if (!session) { setMine({}); return; }
    getMyAnswers(activity.id)
      .then((rows) => {
        const m = {};
        for (const a of rows || []) m[String(a.questionId)] = a;
        setMine(m);
      })
      .catch(() => setMine({}));
  }, [activity.id, session]);

  useEffect(() => {
    let alive = true;
    getResults(activity.id)
      .then((rows) => { if (alive) setResults(rows || []); })
      .catch((e) => { if (alive) setError(e?.message || 'Kunde inte ladda facit.'); });
    return () => { alive = false; };
  }, [activity.id]);

  useEffect(() => { loadMine(); }, [loadMine]);

  const saveKey = async (q, body) => {
    setSaving(String(q.questionId));
    setError(null);
    try {
      const updated = await setAnswerKey(activity.id, q.questionId, body);
      setResults((rs) => rs.map((r) => (String(r.questionId) === String(q.questionId) ? updated : r)));
      loadMine(); // a re-score may flip my correct/awarded
    } catch (e) {
      setError(e?.message || 'Kunde inte spara facit.');
    } finally {
      setSaving(null);
    }
  };

  if (error && !results) return <div className="card error-text">{error}</div>;
  if (!results) return <div className="card center muted" style={{ padding: '1rem' }}><Spinner /> Laddar facit…</div>;
  if (results.length === 0) return null;

  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Svaren per fråga</h3>
      {canManage ? (
        <p className="muted small">
          Fel svar markerat som rätt? Tryck på rätt alternativ (eller ändra det godtagna svaret) —
          allas poäng uppdateras automatiskt.
        </p>
      ) : null}
      {error ? <div className="error-text">{error}</div> : null}
      {results.map((q) => {
        const myA = mine[String(q.questionId)];
        const busy = saving === String(q.questionId);
        const key = String(q.questionId);
        return (
          <div key={key} className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 8, gap: 6 }}>
            <div><b>{q.order}. {q.text}</b></div>

            {q.kind === QuestionKind.FreeText ? (
              canManage ? (
                <div className="row">
                  <input
                    className="grow"
                    value={freeEdits[key] ?? (q.correctAnswerText || '')}
                    onChange={(e) => setFreeEdits((s) => ({ ...s, [key]: e.target.value }))}
                  />
                  <button
                    type="button" className="btn sm" disabled={busy}
                    onClick={() => saveKey(q, { acceptedFreeTextAnswer: freeEdits[key] ?? (q.correctAnswerText || '') })}
                  >
                    Spara
                  </button>
                </div>
              ) : (
                <div className="small">Rätt svar: <b>{q.correctAnswerText || '—'}</b></div>
              )
            ) : (
              <div className="stack" style={{ gap: 4 }}>
                {(q.options || []).map((opt) => {
                  const isCorrect = String(opt.id) === String(q.correctOptionId);
                  const isMine = myA && String(myA.selectedOptionId) === String(opt.id);
                  if (canManage) {
                    return (
                      <button
                        key={opt.id} type="button"
                        className={`btn block ${isCorrect ? 'success' : 'secondary'}`}
                        disabled={busy || isCorrect}
                        onClick={() => saveKey(q, { correctOptionId: opt.id })}
                      >
                        {opt.text}{isCorrect ? ' ✓' : ''}
                      </button>
                    );
                  }
                  return (
                    <div key={opt.id} className={`row small ${isCorrect ? '' : 'muted'}`} style={{ gap: 6, alignItems: 'center' }}>
                      <span className="grow">{opt.text}</span>
                      {isCorrect ? <span className="badge">rätt</span> : null}
                      {isMine && !isCorrect ? <span className="badge">ditt val</span> : null}
                    </div>
                  );
                })}
              </div>
            )}

            {myA ? (
              <div className={`small ${myA.isCorrect ? '' : 'muted'}`}>
                Du: {displayMine(q, myA)} {myA.isCorrect ? '✓' : '✗'}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
