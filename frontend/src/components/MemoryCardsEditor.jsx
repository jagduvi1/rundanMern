// MemoryCardsEditor — author a Memory (card-flip) game's labels. The React port of
// rundan's MemoryCardsEditor.razor. One label per line; each becomes two matching
// cards. A simple textarea → setMemoryCards(activity.id, words[]); the server may
// dedupe/reorder, so the list is rebuilt from the response after a save.
//
// Props:
//   activity  : ActivityDto — { id, ... }.
//   onChanged : () => void — called after a successful save (optional).
import { useEffect, useRef, useState } from 'react';
import { setMemoryCards } from '../api/games';
import { apiGet } from '../api/client';
import Spinner from './Spinner';

// The GET is not admin-gated (per the endpoint inventory) and has no dedicated API
// helper, so read it directly. Returns MemoryCardDto[] = { id, order, text }.
const getMemoryCards = (activityId) => apiGet(`/activities/${activityId}/memory-cards`, { activityId });

export default function MemoryCardsEditor({ activity, onChanged }) {
  const [text, setText] = useState('');
  const [words, setWords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Load once per activity.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const cards = await getMemoryCards(activity.id);
        const w = (cards || []).map((c) => c.text);
        if (alive) { setWords(w); setText(w.join('\n')); }
      } catch (e) {
        if (alive) setError(e?.message || 'Kunde inte ladda korten.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [activity.id]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const list = text.split('\n').map((w) => w.trim()).filter((w) => w.length > 0);
      const cards = await setMemoryCards(activity.id, list);
      const w = (cards || []).map((c) => c.text);
      if (aliveRef.current) { setWords(w); setText(w.join('\n')); }
      onChanged?.();
    } catch (e) {
      setError(e?.message || 'Kunde inte spara korten.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="card center muted"><Spinner /></div>;
  }

  const pairCount = words.length;

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Memorykort ({pairCount} par)</h2>
      <p className="muted small" style={{ margin: 0 }}>
        En etikett per rad — var och en blir två matchande kort. Ord, namn eller emoji fungerar alla. Ett jämnt antal (8–12 par) brukar bli lagom.
      </p>
      {error ? <div className="error-text">{error}</div> : null}
      <textarea
        rows={7}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'äpple\nbanan\n🐱\nSverige'}
        style={{ width: '100%', fontFamily: 'inherit', lineHeight: 1.5 }}
      />
      <button type="button" className="btn sm success" onClick={save} disabled={busy}>
        {busy ? 'Sparar…' : 'Spara kort'}
      </button>
    </div>
  );
}
