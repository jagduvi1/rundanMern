// QuestionEditor — author the question set for a Quiz / Tipspromenad (+ the
// question-library pull). The React port of rundan's QuestionEditor.razor. Lists
// questions with a per-question "needs question" badge, an add/edit form for the
// three kinds (MultipleChoice / TrueFalse / FreeText), and a "from the question
// library" panel that pulls random tagged questions. For Tipspromenad the geofence
// fields are carried through a content edit (placement happens in StationsEditor).
//
// Props:
//   activity  : ActivityDto — { id, type, ... }. usesMap = type === Tipspromenad.
//   onChanged : () => void — called after any mutation so the parent can refresh
//               the sibling StationsEditor (Manage remounts both via a key bump).
import { useEffect, useRef, useState } from 'react';
import {
  getAdminQuestions, createQuestion, updateQuestion, deleteQuestion,
} from '../api/questions';
import { getLibraryTags, getLibraryAvailable, generateFromLibrary } from '../api/library';
import { ActivityType, QuestionKind } from '../config/enums';
import RichTextEditor from './RichTextEditor';
import ImageUploader from './ImageUploader';
import Spinner from './Spinner';

// ── Shared question helpers (mirror of rundan's computed QuestionAdminDto props) ──
function isComplete(q) {
  if (!q) return false;
  if (q.hidden) return true;
  if (!q.text || !q.text.trim()) return false;
  if (q.kind === QuestionKind.FreeText) {
    return !!(q.acceptedFreeTextAnswer && q.acceptedFreeTextAnswer.trim());
  }
  const opts = q.options || [];
  return opts.length >= 2
    && opts.filter((o) => o.isCorrect).length === 1
    && opts.every((o) => o.text && o.text.trim());
}

const kindLabel = (kind) => ({
  [QuestionKind.MultipleChoice]: 'Flerval',
  [QuestionKind.TrueFalse]: 'Sant/falskt',
  [QuestionKind.FreeText]: 'Fritext',
}[kind] || String(kind));

// "topic:sport" → "Sport", "age:family" → "Family".
function tagLabel(tag) {
  const i = tag.indexOf(':');
  const s = i >= 0 ? tag.slice(i + 1) : tag;
  return s.length === 0 ? tag : s[0].toUpperCase() + s.slice(1);
}

const EMPTY_FORM = {
  editId: null,
  order: 0,
  lat: null,
  lng: null,
  radius: null,
  text: '',
  kind: QuestionKind.MultipleChoice,
  points: 1,
  imageUrl: null,
  options: ['', ''],
  correctIndex: 0,
  trueIsCorrect: true,
  acceptedAnswer: '',
};

export default function QuestionEditor({ activity, onChanged }) {
  const usesMap = activity?.type === ActivityType.Tipspromenad;

  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  // Library panel
  const [tags, setTags] = useState([]);
  const [selectedTags, setSelectedTags] = useState(() => new Set());
  const [libCount, setLibCount] = useState(10);
  const [libAvailable, setLibAvailable] = useState(0);
  const [libBusy, setLibBusy] = useState(false);
  const [libError, setLibError] = useState(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const reload = async () => {
    try {
      const list = await getAdminQuestions(activity.id);
      if (aliveRef.current) setQuestions(list || []);
    } catch (e) {
      if (aliveRef.current) setError(e?.message || 'Kunde inte ladda frågorna.');
    }
  };

  const refreshAvailable = async (tagSet) => {
    try {
      const n = await getLibraryAvailable([...tagSet]);
      if (aliveRef.current) setLibAvailable(Number(n) || 0);
    } catch {
      if (aliveRef.current) setLibAvailable(0);
    }
  };

  // Initial load: questions + library tags + available count.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      await reload();
      try {
        const t = await getLibraryTags();
        if (alive) setTags(t || []);
      } catch { /* library is optional */ }
      await refreshAvailable(new Set());
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id]);

  const notifyChanged = () => { onChanged?.(); };

  // ── Library ────────────────────────────────────────────────────────────────
  const topicTags = tags.filter((t) => t.startsWith('topic:'));
  const ageTags = tags.filter((t) => t.startsWith('age:'));
  const difficultyTags = tags.filter((t) => t.startsWith('difficulty:'));

  async function toggleTag(tag) {
    const next = new Set(selectedTags);
    if (next.has(tag)) next.delete(tag); else next.add(tag);
    setSelectedTags(next);
    await refreshAvailable(next);
  }

  // One-tap quick fill — random questions, no tag picking needed.
  async function quickAdd(n) {
    setLibBusy(true);
    setLibError(null);
    try {
      const result = await generateFromLibrary(activity.id, n, []);
      setLibAvailable(Number(result?.available) || 0);
      await reload();
      notifyChanged();
      if ((result?.added || 0) === 0) setLibError('Inga fler frågor i biblioteket.');
    } catch (e) {
      setLibError(e?.message || 'Kunde inte hämta från biblioteket.');
    } finally {
      setLibBusy(false);
    }
  }

  async function generate() {
    setLibBusy(true);
    setLibError(null);
    try {
      const result = await generateFromLibrary(activity.id, libCount, [...selectedTags]);
      setLibAvailable(Number(result?.available) || 0);
      await reload();
      notifyChanged();
      if ((result?.added || 0) === 0) {
        setLibError('Inga matchande frågor kvar för de taggarna.');
      }
    } catch (e) {
      setLibError(e?.message || 'Kunde inte hämta från biblioteket.');
    } finally {
      setLibBusy(false);
    }
  }

  // ── Form ───────────────────────────────────────────────────────────────────
  const setField = (key) => (val) => setForm((s) => ({ ...s, [key]: val }));

  function startEdit(q) {
    const base = {
      ...EMPTY_FORM,
      editId: q.id,
      order: q.order,
      lat: q.latitude ?? null,
      lng: q.longitude ?? null,
      radius: q.radiusMeters ?? null,
      text: q.text || '',
      kind: q.kind,
      points: q.points,
      imageUrl: q.imageUrl || null,
    };
    if (q.kind === QuestionKind.FreeText) {
      base.acceptedAnswer = q.acceptedFreeTextAnswer || '';
    } else if (q.kind === QuestionKind.TrueFalse) {
      base.trueIsCorrect = (q.options || []).find((o) => o.isCorrect)?.text === 'True';
    } else {
      const opts = (q.options || []);
      base.options = opts.length >= 2 ? opts.map((o) => o.text) : ['', ''];
      const ci = opts.findIndex((o) => o.isCorrect);
      base.correctIndex = ci >= 0 ? ci : 0;
    }
    setError(null);
    setForm(base);
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    setError(null);
  }

  function addOption() {
    setForm((s) => ({ ...s, options: [...s.options, ''] }));
  }
  function removeOption(idx) {
    setForm((s) => {
      const options = s.options.filter((_, i) => i !== idx);
      const correctIndex = s.correctIndex >= options.length ? options.length - 1 : s.correctIndex;
      return { ...s, options, correctIndex };
    });
  }
  function setOption(idx, value) {
    setForm((s) => ({ ...s, options: s.options.map((o, i) => (i === idx ? value : o)) }));
  }

  async function save() {
    setBusy(true);
    setError(null);

    const body = {
      order: form.order,
      text: (form.text || '').trim(),
      kind: form.kind,
      points: form.points,
      imageUrl: form.imageUrl || null,
      // Carry the station geofence through a content edit (the PUT replaces these).
      latitude: form.lat,
      longitude: form.lng,
      radiusMeters: form.radius,
    };

    if (form.kind === QuestionKind.MultipleChoice) {
      body.options = form.options
        .map((t, i) => ({ text: (t || '').trim(), isCorrect: i === form.correctIndex }))
        .filter((o) => o.text.length > 0);
    } else if (form.kind === QuestionKind.TrueFalse) {
      body.options = [
        { text: 'True', isCorrect: form.trueIsCorrect },
        { text: 'False', isCorrect: !form.trueIsCorrect },
      ];
    } else {
      body.acceptedFreeTextAnswer = (form.acceptedAnswer || '').trim();
    }

    try {
      if (form.editId != null) await updateQuestion(activity.id, form.editId, body);
      else await createQuestion(activity.id, body);
      resetForm();
      await reload();
      notifyChanged();
    } catch (e) {
      setError(e?.message || 'Kunde inte spara frågan.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(questionId) {
    setBusy(true);
    setError(null);
    try {
      await deleteQuestion(activity.id, questionId);
      if (form.editId === questionId) resetForm();
      await reload();
      notifyChanged();
    } catch (e) {
      setError(e?.message || 'Kunde inte ta bort frågan.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="card center muted"><Spinner /></div>;
  }

  const editIndex = form.editId != null ? questions.findIndex((q) => q.id === form.editId) : -1;

  return (
    <>
      {/* 1) Questions list */}
      <div className="card">
        <h2>Frågor ({questions.length})</h2>
        {questions.length === 0 ? (
          <p className="muted">
            Inga frågor än — lägg till den första nedan{usesMap ? ', eller sätt ett antal stationer ovan.' : '.'}
          </p>
        ) : (
          <ul style={listStyle}>
            {questions.map((q, idx) => (
              <li key={q.id} style={rowStyle}>
                <span className="grow">
                  <b>{idx + 1}.</b>{' '}
                  {q.hidden ? (
                    <span className="muted"><i>Dold — du ser den när du spelar</i></span>
                  ) : !q.text || !q.text.trim() ? (
                    <span className="muted"><i>Ingen fråga än</i></span>
                  ) : (
                    <span dangerouslySetInnerHTML={{ __html: q.text }} />
                  )}
                  <span className="muted" style={{ fontSize: '.78rem' }}>
                    {' · '}{kindLabel(q.kind)} · {q.points} p
                  </span>
                </span>
                {!isComplete(q) ? <span className="pill warn" title="Behöver text och en rätt-mall">behöver fråga</span> : null}
                {!q.hidden ? (
                  <button type="button" className="btn ghost sm" onClick={() => startEdit(q)} disabled={busy}>
                    {!q.text || !q.text.trim() ? 'Lägg till fråga' : 'Ändra'}
                  </button>
                ) : null}
                <button type="button" className="btn ghost sm danger" onClick={() => remove(q.id)} disabled={busy}>✕</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 2) Library */}
      <div className="card stack">
        <h2>Från frågebiblioteket</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Hämta slumpade frågor du inte skrivit själv (bra när värden också spelar). De markeras som använda så de inte upprepas.
        </p>

        {/* One-tap quick fill — the easy path. */}
        <div className="row wrap" style={{ gap: 6 }}>
          <button type="button" className="btn success" onClick={() => quickAdd(10)} disabled={libBusy || libAvailable === 0}>
            {libBusy ? 'Hämtar…' : '+ 10 blandade frågor'}
          </button>
          <button type="button" className="btn soft sm" onClick={() => quickAdd(5)} disabled={libBusy || libAvailable === 0}>+ 5</button>
          <span className="muted small" style={{ alignSelf: 'center' }}>Snabbast — eller välj kategorier nedan.</span>
        </div>

        {libError ? <div className="error-text">{libError}</div> : null}

        {[['Kategorier (välj en eller flera)', topicTags], ['Ålder (valfritt)', ageTags], ['Svårighet (valfritt)', difficultyTags]]
          .filter(([, group]) => group.length > 0)
          .map(([label, group]) => (
            <div className="field" key={label} style={{ margin: 0 }}>
              <label>{label}</label>
              <div className="row wrap" style={{ gap: '.4rem' }}>
                {group.map((tag) => (
                  <button
                    type="button"
                    key={tag}
                    className={`btn sm ${selectedTags.has(tag) ? '' : 'ghost'}`}
                    onClick={() => toggleTag(tag)}
                  >
                    {tagLabel(tag)}
                  </button>
                ))}
              </div>
            </div>
          ))}

        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ width: 150, margin: 0 }}>
            <label>Antal frågor</label>
            <input type="number" min={1} max={50} value={libCount} onChange={(e) => setLibCount(Number(e.target.value))} />
          </div>
          <span className="muted grow small" style={{ alignSelf: 'flex-end', paddingBottom: '.6rem' }}>{libAvailable} tillgängliga</span>
          <button type="button" className="btn success" onClick={generate} disabled={libBusy || libAvailable === 0}>
            {libBusy ? 'Hämtar…' : 'Lägg till slumpade'}
          </button>
        </div>
      </div>

      {/* 3) Add / edit form */}
      <div className="card stack">
        <h2>{form.editId == null ? 'Lägg till en fråga' : `Ändra ${usesMap ? `station #${editIndex + 1}` : `fråga #${editIndex + 1}`}`}</h2>

        {error ? <div className="error-text">{error}</div> : null}

        <div className="field">
          <label>Fråga</label>
          <RichTextEditor value={form.text} onChange={setField('text')} placeholder="Vad är frågan?" />
        </div>

        <div className="field">
          <label>Bild (valfritt)</label>
          <ImageUploader value={form.imageUrl} onChange={setField('imageUrl')} />
        </div>

        <div className="row">
          <div className="field grow">
            <label>Typ</label>
            <select value={form.kind} onChange={(e) => setField('kind')(Number(e.target.value))}>
              <option value={QuestionKind.MultipleChoice}>Flerval</option>
              <option value={QuestionKind.TrueFalse}>Sant / falskt</option>
              <option value={QuestionKind.FreeText}>Fritext</option>
            </select>
          </div>
          <div className="field" style={{ width: 90 }}>
            <label>Poäng</label>
            <input type="number" min={0} max={100} value={form.points} onChange={(e) => setField('points')(Number(e.target.value))} />
          </div>
        </div>

        {form.kind === QuestionKind.MultipleChoice ? (
          <div className="field">
            <label>Alternativ (tryck på cirkeln för att markera det rätta)</label>
            {form.options.map((opt, i) => (
              <div className="row" key={i} style={{ marginBottom: '.4rem' }}>
                <input
                  type="radio"
                  name={`correct-${activity.id}`}
                  style={{ width: 'auto', minHeight: 'auto' }}
                  checked={form.correctIndex === i}
                  onChange={() => setField('correctIndex')(i)}
                />
                <input
                  type="text"
                  className="grow"
                  placeholder={`Alternativ ${i + 1}`}
                  value={opt}
                  onChange={(e) => setOption(i, e.target.value)}
                />
                {form.options.length > 2 ? (
                  <button type="button" className="btn ghost sm" onClick={() => removeOption(i)}>✕</button>
                ) : null}
              </div>
            ))}
            <button type="button" className="btn ghost sm" onClick={addOption}>+ Lägg till alternativ</button>
          </div>
        ) : form.kind === QuestionKind.TrueFalse ? (
          <div className="field">
            <label>Rätt svar</label>
            <select value={String(form.trueIsCorrect)} onChange={(e) => setField('trueIsCorrect')(e.target.value === 'true')}>
              <option value="true">Sant</option>
              <option value="false">Falskt</option>
            </select>
          </div>
        ) : (
          <div className="field">
            <label>Godtaget svar (skiftlägesokänsligt)</label>
            <input type="text" value={form.acceptedAnswer} onChange={(e) => setField('acceptedAnswer')(e.target.value)} placeholder="Den rätta texten" />
          </div>
        )}

        <div className="row">
          <button type="button" className="btn block success" onClick={save} disabled={busy || !(form.text || '').trim()}>
            {form.editId == null ? 'Lägg till fråga' : 'Spara ändringar'}
          </button>
          {form.editId != null ? (
            <button type="button" className="btn ghost" onClick={resetForm} disabled={busy}>Avbryt</button>
          ) : null}
        </div>
      </div>
    </>
  );
}

const listStyle = { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 };
const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
