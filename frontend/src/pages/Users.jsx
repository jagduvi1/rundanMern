// Users — "/admin/users" — the People roster (port of rundan's Users.razor).
// Pre-register people once; they're picked into events later. Host-only (the route
// is wrapped in ProtectedRoute). Renders the AdminNav (sibling) at the top.
import { useEffect, useState } from 'react';
import { listUsers, createUser, updateUser, deleteUser } from '../api/users';
import { ApiError } from '../api/client';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import { useToast } from '../components/Toast';
import ConfirmDialog from '../components/ConfirmDialog';
import AdminNav from '../components/AdminNav';

export default function Users() {
  useDocumentTitle('Personer · Värd · Rundan');
  const { toast, show } = useToast();

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [renameId, setRenameId] = useState(null);
  const [renameName, setRenameName] = useState('');
  const [confirmId, setConfirmId] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      setUsers(await listUsers());
    } catch (err) {
      show(err instanceof ApiError ? err.message : 'Kunde inte ladda personer.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const add = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await createUser(name);
      setNewName('');
      await load();
    } catch (err) {
      show(err?.message || 'Kunde inte lägga till.');
    } finally {
      setBusy(false);
    }
  };

  const startRename = (u) => { setRenameId(u.id); setRenameName(u.name); };

  const rename = async (uid) => {
    const name = renameName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await updateUser(uid, name);
      setRenameId(null);
      await load();
    } catch (err) {
      show(err?.message || 'Kunde inte byta namn.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (uid) => {
    setConfirmId(null);
    setBusy(true);
    try {
      await deleteUser(uid);
      await load();
    } catch (err) {
      show(err?.message || 'Kunde inte ta bort.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {toast}
      <AdminNav active="people" />

      <div className="card stack">
        <h1>Personer</h1>
        <p className="muted">Registrera alla en gång. Sedan väljer du in dem i varje evenemang.</p>
        <div className="row">
          <input
            className="grow"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
            placeholder="Lägg till en person"
            maxLength={60}
          />
          <button type="button" className="btn sm success" onClick={add} disabled={busy || !newName.trim()}>Lägg till</button>
        </div>

        {loading ? (
          <span className="spinner" style={{ margin: '1rem auto' }} />
        ) : users.length === 0 ? (
          <p className="muted">Inga personer ännu.</p>
        ) : (
          <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 8 }}>
            {users.map((u) => (
              <li key={u.id} className="row">
                {renameId === u.id ? (
                  <>
                    <input
                      className="grow"
                      value={renameName}
                      onChange={(e) => setRenameName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') rename(u.id); }}
                      maxLength={60}
                      autoFocus
                    />
                    <button type="button" className="btn sm success" onClick={() => rename(u.id)} disabled={busy || !renameName.trim()}>Spara</button>
                    <button type="button" className="btn ghost sm" onClick={() => setRenameId(null)}>Avbryt</button>
                  </>
                ) : (
                  <>
                    <span className="grow">{u.name}</span>
                    <button type="button" className="btn ghost sm" onClick={() => startRename(u)} disabled={busy}>Byt namn</button>
                    <button type="button" className="btn ghost sm danger" onClick={() => setConfirmId(u.id)} disabled={busy}>✕</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmId != null}
        title="Ta bort person?"
        message="Personen tas bort från rostret."
        confirmLabel="Ta bort"
        danger
        onConfirm={() => remove(confirmId)}
        onCancel={() => setConfirmId(null)}
      />
    </>
  );
}
