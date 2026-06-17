// Home — "/" — the cold-start launcher/router (port of rundan's Home.razor). It
// is NOT a real page: it decides where to send a returning visitor and redirects,
// only rendering the welcome/empty state when there's genuinely nowhere to go.
//
//   • last-opened event (if it still exists)  → /e/:id
//   • exactly one event still in play         → /e/:id
//   • the only event there is (even finished) → /e/:id
//   • several with no clear winner            → /events
//   • nothing / load failure                  → welcome + empty card
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listActiveEvents } from '../api/events';
import { getLastEventId } from '../utils/appState';
import { useBootstrap } from '../contexts/BootstrapContext';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import WelcomeHero from '../components/WelcomeHero';

// Returns the id to land on, or null ("can't decide — don't redirect").
function pickLandingEvent(events) {
  if (!events || events.length === 0) return null;

  const lastId = getLastEventId();
  if (lastId && events.some((e) => String(e.id) === String(lastId))) return lastId;

  // No usable history: ignore finished days and land on the single one still in
  // play. If the only event there is has finished, still open it — it's all there is.
  const inPlay = events.filter((e) => !e.isComplete);
  if (inPlay.length === 1) return inPlay[0].id;
  if (inPlay.length === 0 && events.length === 1) return events[0].id;
  return null;
}

export default function Home() {
  useDocumentTitle('GameDo');
  const navigate = useNavigate();
  const { appName } = useBootstrap();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const events = await listActiveEvents();
        if (cancelled) return;
        const landing = pickLandingEvent(events);
        if (landing) {
          navigate(`/e/${landing}`, { replace: true });
          return;
        }
        if (events.length > 1) {
          navigate('/events', { replace: true });
          return;
        }
      } catch {
        // Network / parse failure — fall through to the welcome state rather than
        // hang the spinner.
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [navigate]);

  if (loading) {
    return <div className="card center muted"><span className="spinner" style={{ margin: '1rem auto' }} /></div>;
  }

  return (
    <>
      <WelcomeHero appName={appName} onAction={() => navigate('/events')} />
      <div className="card stack">
        <h2>Inget inplanerat ännu</h2>
        <p className="muted">
          När din värd sätter upp en dag dyker den upp här. Har du en kod?
          Öppna menyn (uppe till vänster ☰) för att hoppa in.
        </p>
      </div>
    </>
  );
}
