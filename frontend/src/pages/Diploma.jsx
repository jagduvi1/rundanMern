// Diploma — "/diploma/:id" — a print/PDF-friendly champion certificate for a
// finished event (port of rundan's Diploma.razor). Only awards when the event is
// complete; otherwise a "no champion yet" card. The print toolbar is .no-print so
// it's hidden when printing (the print CSS is expected in index.css / siblings).
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getEvent, getStandings } from '../api/events';
import { num } from '../utils/format';
import { useDocumentTitle } from '../utils/useDocumentTitle';

export default function Diploma() {
  useDocumentTitle('Diplom · Gamedo');
  const { id } = useParams();

  const [event, setEvent] = useState(null);
  const [winners, setWinners] = useState([]);
  const [podium, setPodium] = useState([]);
  const [topPoints, setTopPoints] = useState(0);
  const [loading, setLoading] = useState(true);

  const dateText = new Date().toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ev, standings] = await Promise.all([getEvent(id), getStandings(id).catch(() => null)]);
        if (cancelled) return;
        setEvent(ev);
        if (standings) {
          const entries = standings.entries || [];
          // Only award once the day is actually done.
          setWinners(ev?.isComplete ? entries.filter((e) => e.rank === 1).map((e) => e.displayName) : []);
          setTopPoints(entries[0]?.totalPoints ?? 0);
          setPodium(entries.slice(0, 3));
        }
      } catch { /* show the empty state */ } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return <div className="card center muted"><span className="spinner" style={{ margin: '1rem auto' }} /></div>;
  }

  if (!event || winners.length === 0) {
    return (
      <div className="card stack center">
        <h1>Ingen mästare ännu</h1>
        <p className="muted">Diplomet visas när evenemanget är avslutat och poängsatt.</p>
        <Link className="btn" to={`/e/${id}`}>Tillbaka till evenemanget</Link>
      </div>
    );
  }

  return (
    <>
      <div className="diploma card stack center" style={{ textAlign: 'center', padding: '2rem 1.25rem' }}>
        <img src="/assets/gamedo-mark.svg" width={56} height={56} alt="" style={{ margin: '0 auto' }} />
        <div className="muted" style={{ letterSpacing: '.08em', textTransform: 'uppercase', fontSize: '.8rem' }}>
          Mästardiplom
        </div>
        <h1 style={{ margin: '.3rem 0' }}>{event.name}</h1>
        <div className="muted">Detta tilldelas</div>
        <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{winners.join(' & ')}</div>
        <div className="muted">
          Mästare{winners.length > 1 ? '' : ''} med <b>{num(topPoints)}</b> poäng · {dateText}
        </div>

        {podium.length > 1 ? (
          <div className="stack" style={{ alignSelf: 'stretch', marginTop: 8 }}>
            {podium.map((e) => (
              <div key={`${e.userId ?? e.displayName}`} className="row" style={{ justifyContent: 'center', gap: 10 }}>
                <span style={{ fontWeight: 700, color: 'var(--text-muted)' }}>{e.rank}.</span>
                <span className="grow" style={{ textAlign: 'left' }}>{e.displayName}</span>
                <span style={{ fontWeight: 700 }}>{num(e.totalPoints)} p</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="muted small" style={{ marginTop: 10 }}>
          Gamedo · {(event.activities || []).length} aktiviteter
        </div>
      </div>

      <div className="no-print row" style={{ justifyContent: 'center', margin: '1rem 0 2rem' }}>
        <button type="button" className="btn" onClick={() => window.print()}>🖨 Skriv ut / Spara som PDF</button>
        <Link className="btn ghost" to={`/e/${id}`}>Tillbaka</Link>
      </div>
    </>
  );
}
