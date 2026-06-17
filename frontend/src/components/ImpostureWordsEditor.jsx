// ImpostureWordsEditor — author the secret-word list for an Imposture game (host,
// Draft only). Each round the server picks one word; everyone but the impostor
// sees it. Words are host-only — they never reach players via the activity DTO.
//
// Props:
//   activity  : ActivityDto — reads { id, impostureWords }.
//   onChanged : () => void — called after add/remove so the parent can refresh.
import { useEffect, useRef, useState } from 'react';
import { getActivity } from '../api/activities';
import { addImpostureWord, removeImpostureWord, addImpostureStarter } from '../api/imposture';
import Spinner from './Spinner';

export default function ImpostureWordsEditor({ activity, onChanged }) {
  const [words, setWords] = useState(activity?.impostureWords || []);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [word, setWord] = useState('');
  const [category, setCategory] = useState('');

  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  // The parent re-keys this editor without refetching the activity prop, so pull
  // the (host-only) word list fresh on mount.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      const fresh = await getActivity(activity.id).catch(() => null);
      if (alive) {
        if (fresh?.impostureWords) setWords(fresh.impostureWords);
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [activity.id]);

  const add = async () => {
    if (!word.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await addImpostureWord(activity.id, word.trim(), category.trim());
      if (aliveRef.current) { setWords(res?.words || []); setWord(''); setCategory(''); }
      onChanged?.();
    } catch (e) {
      setError(e?.message || 'Kunde inte lägga till ordet.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (w) => {
    setBusy(true);
    setError(null);
    try {
      const res = await removeImpostureWord(activity.id, w.id);
      if (aliveRef.current) setWords(res?.words || []);
      onChanged?.();
    } catch (e) {
      setError(e?.message || 'Kunde inte ta bort ordet.');
    } finally {
      setBusy(false);
    }
  };

  const starter = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await addImpostureStarter(activity.id);
      if (aliveRef.current) setWords(res?.words || []);
      onChanged?.();
    } catch (e) {
      setError(e?.message || 'Kunde inte lägga till startpaketet.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="card center muted"><Spinner /></div>;

  return (
    <div className="card stack">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>Hemliga ord ({words.length})</h2>
        <button type="button" className="btn ghost sm" onClick={starter} disabled={busy}>Lägg till startpaket</button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Varje runda väljs ett ord. Alla utom impostorn får se det. En valfri kategori visas som ledtråd (och kan visas för impostorn — se inställningarna ovan). Spelarna ser aldrig listan.
      </p>
      {error ? <div className="error-text">{error}</div> : null}

      <div className="row wrap" style={{ gap: '.4rem', alignItems: 'flex-end' }}>
        <div className="field grow" style={{ margin: 0, minWidth: 160 }}>
          <label className="muted small">Ord</label>
          <input
            type="text" placeholder="t.ex. Pizza" value={word}
            onChange={(e) => setWord(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          />
        </div>
        <div className="field" style={{ margin: 0, minWidth: 120 }}>
          <label className="muted small">Kategori (valfri)</label>
          <input
            type="text" placeholder="t.ex. Mat" value={category}
            onChange={(e) => setCategory(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          />
        </div>
        <button type="button" className="btn sm" onClick={add} disabled={busy || !word.trim()}>Lägg till</button>
      </div>

      {words.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>Inga ord än — lägg till några eller tryck “Lägg till startpaket”.</p>
      ) : (
        <div className="stack" style={{ gap: '.3rem' }}>
          {words.map((w) => (
            <div key={w.id} className="row" style={{ gap: '.5rem', alignItems: 'center' }}>
              <span className="grow"><b>{w.word}</b>{w.category ? <span className="muted small"> · {w.category}</span> : null}</span>
              <button type="button" className="btn ghost sm danger" onClick={() => remove(w)} disabled={busy}>Ta bort</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
