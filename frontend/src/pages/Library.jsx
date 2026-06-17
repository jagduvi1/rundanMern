import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listActivities, getUsedInEvents } from '../api/activities';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import { useToast } from '../components/Toast';
import AdminNav from '../components/AdminNav';
import StatusBadge from '../components/StatusBadge';
import Spinner from '../components/Spinner';
import { typeLabel } from '../utils/format';

export default function Library() {
  useDocumentTitle('Aktivitetsbibliotek · Rundan');
  const navigate = useNavigate();
  const { toast, show } = useToast();

  const [activities, setActivities] = useState([]);
  const [usedIn, setUsedIn] = useState({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const list = await listActivities();
        const pub = (list || []).filter((a) => a.isPublic);
        setActivities(pub);
        const entries = await Promise.all(
          pub.map((a) => getUsedInEvents(a.id).then((evs) => [a.id, evs]).catch(() => [a.id, []])),
        );
        const map = {};
        for (const [id, evs] of entries) map[id] = evs;
        setUsedIn(map);
      } catch (e) {
        show(e?.message || 'Kunde inte ladda biblioteket.');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = filter
    ? activities.filter((a) => {
        const q = filter.toLowerCase();
        return (
          a.title?.toLowerCase().includes(q) ||
          typeLabel(a.type)?.toLowerCase().includes(q)
        );
      })
    : activities;

  return (
    <>
      {toast}
      <AdminNav active="library" />

      <div className="card stack">
        <div className="spread">
          <h2 style={{ margin: 0 }}>Aktivitetsbibliotek</h2>
          <span className="muted small">{activities.length} publika</span>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Aktiviteter som delats till biblioteket. Dessa kan återanvändas som kopior i nya evenemang.
        </p>

        {activities.length > 4 ? (
          <input
            type="text"
            placeholder="Filtrera på titel eller typ…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        ) : null}
      </div>

      {loading ? (
        <div className="card center"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div className="card center muted">
          {activities.length === 0
            ? 'Inga aktiviteter har delats till biblioteket ännu. Markera en aktivitet som publik i hanteringsvyn.'
            : 'Inga aktiviteter matchar filtret.'}
        </div>
      ) : (
        <div style={gridStyle}>
          {filtered.map((a) => {
            const events = usedIn[a.id] || [];
            return (
              <div
                key={a.id}
                className="card stack"
                style={cardStyle}
                onClick={() => navigate(`/manage/${a.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/manage/${a.id}`); }}
              >
                <div className="spread" style={{ alignItems: 'flex-start' }}>
                  <h3 style={{ margin: 0, fontSize: '1rem' }}>{a.title}</h3>
                  <StatusBadge status={a.status} />
                </div>
                <span className="muted small">{typeLabel(a.type)}</span>
                {a.questionCount > 0 ? (
                  <span className="muted small">{a.questionCount} frågor</span>
                ) : null}
                {events.length > 0 ? (
                  <div className="muted small" onClick={(e) => e.stopPropagation()}>
                    Används i:{' '}
                    {events.map((ev, i) => (
                      <span key={ev.id}>
                        {i > 0 ? ', ' : ''}
                        <Link to={`/e/${ev.id}`}>{ev.name}</Link>
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="row" style={{ marginTop: 'auto' }}>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={(e) => { e.stopPropagation(); navigate(`/manage/${a.id}`); }}
                  >
                    Hantera
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={(e) => { e.stopPropagation(); navigate(`/a/${a.id}`); }}
                  >
                    Öppna
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
  gap: 12,
};

const cardStyle = {
  cursor: 'pointer',
  background: 'var(--surface-2)',
  gap: 6,
  minHeight: 120,
};
