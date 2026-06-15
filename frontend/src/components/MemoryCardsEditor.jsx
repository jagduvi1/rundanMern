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

// One-tap themed packs so a host doesn't have to type every pair (10 pairs each).
const PRESETS = [
  { name: '🏙️ Svenska städer', items: ['Stockholm', 'Göteborg', 'Malmö', 'Uppsala', 'Västerås', 'Örebro', 'Linköping', 'Helsingborg', 'Norrköping', 'Lund'] },
  { name: '🐾 Djur', items: ['Hund', 'Katt', 'Häst', 'Ko', 'Gris', 'Får', 'Höna', 'Räv', 'Älg', 'Igelkott'] },
  { name: '🍎 Frukt', items: ['Äpple', 'Banan', 'Apelsin', 'Päron', 'Jordgubbe', 'Vindruva', 'Citron', 'Melon', 'Körsbär', 'Ananas'] },
  { name: '😺 Emoji', items: ['🐱', '🐶', '🦊', '🐼', '🐸', '🐵', '🦁', '🐯', '🐮', '🐷'] },
  { name: '🎨 Färger', items: ['Röd', 'Blå', 'Grön', 'Gul', 'Lila', 'Orange', 'Rosa', 'Svart', 'Vit', 'Brun'] },
  { name: '🔢 Siffror', items: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] },
  { name: '🌍 Länder', items: ['Sverige', 'Norge', 'Danmark', 'Finland', 'Island', 'Tyskland', 'Frankrike', 'Spanien', 'Italien', 'Polen'] },
];

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
        const res = await getMemoryCards(activity.id);
        const w = (res?.cards || res || []).map((c) => c.text);
        if (alive) { setWords(w); setText(w.join('\n')); }
      } catch (e) {
        if (alive) setError(e?.message || 'Kunde inte ladda korten.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [activity.id]);

  async function saveList(list) {
    setBusy(true);
    setError(null);
    try {
      const result = await setMemoryCards(activity.id, list);
      const w = result?.words || [];
      if (aliveRef.current) { setWords(w); setText(w.join('\n')); }
      onChanged?.();
    } catch (e) {
      setError(e?.message || 'Kunde inte spara korten.');
    } finally {
      setBusy(false);
    }
  }

  const save = () => saveList(text.split('\n').map((w) => w.trim()).filter((w) => w.length > 0));

  // Fill the box with a preset AND save it in one tap.
  const applyPreset = (items) => { setText(items.join('\n')); saveList(items); };

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

      <div className="stack" style={{ gap: 6 }}>
        <label style={{ margin: 0 }}>Snabbfyll med en färdig uppsättning (ett tryck):</label>
        <div className="row wrap" style={{ gap: 6 }}>
          {PRESETS.map((p) => (
            <button key={p.name} type="button" className="btn ghost sm" disabled={busy} onClick={() => applyPreset(p.items)}>
              {p.name}
            </button>
          ))}
        </div>
        <span className="muted small">…eller skriv din egen lista nedan.</span>
      </div>

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
