// QuizPlay — classic sit-down quiz. Sequential reveal: one question at a time,
// submit → instant correct/wrong feedback → next. No browsing back/forward.
//
// The React port of rundan's QuizPlay.razor.
//
// Props:
//   activity   : ActivityDto — { id, randomizeQuestions, ... }.
//   participant: ParticipantDto — { id, displayName, ... } (its id seeds the
//                deterministic per-player shuffle so order is stable on reload).
//
// QuestionDto:    { id, order, text, kind, points, imageUrl?, options:[{id,order,text}] }
// MyAnswerDto:    { questionId, selectedOptionId?, freeText?, isCorrect, awardedPoints }
// AnswerResultDto:{ questionId, isCorrect, awardedPoints, answeredCount, totalQuestions, ... }
import { useEffect, useState } from 'react';
import { getQuestions } from '../api/questions';
import { submitAnswer, getMyAnswers } from '../api/gameplay';
import { QuestionKind } from '../config/enums';
import Spinner from './Spinner';

// ── Shared answer-UI helpers (the Swedish 1·X·2 keying + the option button) ────
// rundan keys 3-option questions the football-coupon way (1 / X / 2) and
// everything else A, B, C, D…; each key carries an accent colour. Kept local to
// avoid a shared module (the component set is fixed).
export function OptionKey(index, count) {
  return count === 3 ? ['1', 'X', '2'][index] : String.fromCharCode(65 + index);
}
export function optionColor(index, count) {
  // 1 = blue, X = amber, 2 = green for coupons; accent otherwise.
  return count === 3 ? ['var(--key-1)', 'var(--key-x)', 'var(--key-2)'][index] : 'var(--accent)';
}

// Deterministic per-player shuffle: a mulberry32 PRNG seeded from a hash of the
// participant id. Order is stable across reloads for one player and differs
// between players (anti-copying). Cross-language parity with the C# isn't needed
// — only intra-player stability is.
export function seededShuffle(items, seedSource) {
  const arr = items.slice();
  let h = 1779033703 ^ String(seedSource ?? '').length;
  for (let i = 0; i < String(seedSource ?? '').length; i += 1) {
    h = Math.imul(h ^ String(seedSource).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  const rng = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Inline success/error "alert" styling (index.css has no .alert class).
export function feedbackStyle(ok) {
  return {
    padding: '10px 12px',
    borderRadius: 'var(--radius-sm)',
    fontWeight: 600,
    background: ok ? 'var(--ok-soft)' : 'var(--danger-soft)',
    color: ok ? 'var(--ok-ink)' : 'var(--danger-ink)',
  };
}

// One answer option rendered as a big tappable button. `state` ∈
// '' | 'selected' | 'correct' | 'wrong' drives the border/background.
export function OptionButton({ indexKey, accent, text, mark, state, disabled, onClick }) {
  const palette = {
    '': { border: 'var(--border)', bg: 'var(--surface)' },
    selected: { border: accent, bg: 'var(--accent-soft)' },
    correct: { border: 'var(--ok)', bg: 'var(--ok-soft)' },
    wrong: { border: 'var(--danger)', bg: 'var(--danger-soft)' },
  }[state] || { border: 'var(--border)', bg: 'var(--surface)' };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        textAlign: 'left',
        padding: '12px 14px',
        borderRadius: 'var(--radius-sm)',
        border: `2px solid ${palette.border}`,
        background: palette.bg,
        color: 'var(--text)',
        font: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        minHeight: 48,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flex: '0 0 auto',
          width: 28,
          height: 28,
          borderRadius: 8,
          display: 'grid',
          placeItems: 'center',
          fontWeight: 700,
          color: '#fff',
          background: accent,
        }}
      >
        {indexKey}
      </span>
      <span style={{ flex: 1, fontWeight: 600 }}>{text}</span>
      <span style={{ flex: '0 0 auto', width: 18, textAlign: 'center', fontWeight: 700 }}>{mark}</span>
    </button>
  );
}

export default function QuizPlay({ activity, participant }) {
  const [loading, setLoading] = useState(true);
  const [questions, setQuestions] = useState([]);
  const [answered, setAnswered] = useState(() => new Map()); // questionId → MyAnswerDto
  const [index, setIndex] = useState(0);
  const [selectedOptionId, setSelectedOptionId] = useState(null);
  const [freeText, setFreeText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // First unanswered question, else the last one (sequential reveal).
  function firstUnanswered(qs, map) {
    for (let i = 0; i < qs.length; i += 1) {
      if (!map.has(String(qs[i].id))) return i;
    }
    return Math.max(0, qs.length - 1);
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        let qs = await getQuestions(activity.id);
        if (activity.randomizeQuestions) qs = seededShuffle(qs, participant?.id);
        const mine = await getMyAnswers(activity.id);
        if (!alive) return;
        const map = new Map(mine.map((a) => [String(a.questionId), a]));
        setQuestions(qs);
        setAnswered(map);
        setIndex(firstUnanswered(qs, map));
      } catch (e) {
        if (alive) setError(e?.message || 'Kunde inte ladda frågorna.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // Reload only when the activity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id]);

  const answeredCount = answered.size;
  const total = questions.length;
  const q = questions[index];
  const mine = q ? answered.get(String(q.id)) : null;

  function goNext() {
    setIndex(firstUnanswered(questions, answered));
    setSelectedOptionId(null);
    setFreeText('');
    setError(null);
  }

  async function send(body) {
    if (!q) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitAnswer(activity.id, body);
      // Store a synthetic MyAnswerDto from the request + the server's verdict.
      setAnswered((prev) => {
        const next = new Map(prev);
        next.set(String(q.id), {
          questionId: q.id,
          selectedOptionId: body.selectedOptionId ?? null,
          freeText: body.freeText ?? null,
          isCorrect: result.isCorrect,
          awardedPoints: result.awardedPoints,
        });
        return next;
      });
      setSelectedOptionId(null);
    } catch (e) {
      setError(e?.message || 'Kunde inte skicka svaret.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="card center muted" style={{ padding: '1.2rem' }}>
        <Spinner /> Laddar frågor…
      </div>
    );
  }
  if (total === 0) {
    return <div className="card muted">Inga frågor i den här aktiviteten.</div>;
  }

  const isFreeText = q.kind === QuestionKind.FreeText;

  return (
    <div className="card stack">
      <div className="muted small">
        Fråga {index + 1} av {total} · {answeredCount} besvarade · värd {q.points} p
      </div>
      <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{q.text}</div>

      {q.imageUrl ? (
        <img src={q.imageUrl} alt="" style={{ borderRadius: 'var(--radius-sm)' }} />
      ) : null}

      {error ? <div className="error-text">{error}</div> : null}

      {isFreeText ? (
        <FreeTextBlock
          mine={mine}
          value={freeText}
          onChange={setFreeText}
          submitting={submitting}
          onSubmit={() => send({ questionId: q.id, freeText: freeText.trim() })}
        />
      ) : (
        <div className="stack">
          {(q.options || []).map((opt, i) => (
            <OptionButton
              key={opt.id}
              indexKey={OptionKey(i, q.options.length)}
              accent={optionColor(i, q.options.length)}
              text={opt.text}
              mark={mine && String(opt.id) === String(mine.selectedOptionId)
                ? (mine.isCorrect ? '✓' : '✗')
                : ''}
              state={optionState(mine, opt, selectedOptionId)}
              disabled={!!mine || submitting}
              onClick={() => {
                setSelectedOptionId(opt.id);
                setError(null);
              }}
            />
          ))}
          {!mine ? (
            <button
              className="btn block"
              disabled={selectedOptionId == null || submitting}
              onClick={() => send({ questionId: q.id, selectedOptionId })}
            >
              Skicka svar
            </button>
          ) : (
            <div style={feedbackStyle(mine.isCorrect)}>
              {mine.isCorrect ? `Rätt! +${mine.awardedPoints}` : 'Inte den här gången.'}
            </div>
          )}
        </div>
      )}

      {mine ? (
        answeredCount < total ? (
          <button className="btn block" onClick={goNext}>Nästa fråga →</button>
        ) : (
          <div style={feedbackStyle(true)} className="center">
            Allt klart — snyggt jobbat! Luta dig tillbaka och invänta resultatet.
          </div>
        )
      ) : null}
    </div>
  );
}

// Before answering: "selected" if chosen. After: "correct"/"wrong" on the chosen
// option only (others stay neutral).
function optionState(mine, opt, selectedOptionId) {
  if (!mine) return String(selectedOptionId) === String(opt.id) ? 'selected' : '';
  if (String(opt.id) === String(mine.selectedOptionId)) return mine.isCorrect ? 'correct' : 'wrong';
  return '';
}

function FreeTextBlock({ mine, value, onChange, submitting, onSubmit }) {
  if (!mine) {
    return (
      <div className="stack">
        <input
          type="text"
          placeholder="Skriv ditt svar"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button className="btn block" disabled={submitting || value.trim().length === 0} onClick={onSubmit}>
          Skicka svar
        </button>
      </div>
    );
  }
  return (
    <div style={feedbackStyle(mine.isCorrect)}>
      Du svarade: <b>{mine.freeText}</b>
      <br />
      {mine.isCorrect ? `Rätt! +${mine.awardedPoints}` : 'Inte rätt.'}
    </div>
  );
}
