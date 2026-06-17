// Accounts — "/admin/accounts" — super-admin user & role administration. Lists
// every account and lets a super-admin grant/revoke the admin role. Accounts that
// are super-admin via ADMIN_EMAILS (env) are shown but not toggleable here.
import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import AdminNav from '../components/AdminNav';
import Spinner from '../components/Spinner';
import { listAccounts, setAccountRole } from '../api/maintenance';

export default function Accounts() {
  useDocumentTitle('Konton · GameDo');
  const { isAdmin } = useAuth();
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    try { setAccounts(await listAccounts()); }
    catch (e) { setError(e?.message || 'Kunde inte ladda konton.'); }
  };
  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);

  if (!isAdmin) {
    return (
      <>
        <AdminNav />
        <div className="card"><h2>Konton</h2><p className="muted">Endast superadmin har åtkomst.</p></div>
      </>
    );
  }

  const toggle = async (a) => {
    setBusyId(a.id);
    setError(null);
    try {
      await setAccountRole(a.id, !a.isAdmin);
      await load();
    } catch (e) {
      setError(e?.message || 'Kunde inte ändra rollen.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <AdminNav active="accounts" />
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Konton</h2>
        <p className="muted small" style={{ marginTop: '-.4rem' }}>
          Alla värdkonton. Ge eller ta bort adminrollen. Konton som är superadmin via ADMIN_EMAILS hanteras i serverns miljövariabler.
        </p>
        {error ? <p className="error-text">{error}</p> : null}
        {accounts == null ? (
          <div className="center"><Spinner /></div>
        ) : accounts.length === 0 ? (
          <p className="muted">Inga konton ännu.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="board" style={{ fontSize: '.9rem' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Konto</th>
                  <th style={{ textAlign: 'left' }}>E-post</th>
                  <th>Verifierad</th>
                  <th>Admin</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td><b>{a.displayName}</b> <span className="muted small">@{a.username}</span></td>
                    <td className="muted small" style={{ wordBreak: 'break-all' }}>{a.email}</td>
                    <td style={{ textAlign: 'center' }}>{a.emailVerified ? '✓' : '—'}</td>
                    <td style={{ textAlign: 'center' }}>
                      {a.isAdmin ? <span className="pill ok small">admin</span> : <span className="muted small">user</span>}
                      {a.isEnvAdmin ? <span className="muted small" title="Superadmin via ADMIN_EMAILS"> (env)</span> : null}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {a.isEnvAdmin ? (
                        <span className="muted small">låst</span>
                      ) : (
                        <button
                          type="button"
                          className={`btn sm ${a.isAdmin ? 'ghost' : ''}`}
                          onClick={() => toggle(a)}
                          disabled={busyId === a.id}
                        >
                          {busyId === a.id ? '…' : a.isAdmin ? 'Ta bort admin' : 'Gör till admin'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
