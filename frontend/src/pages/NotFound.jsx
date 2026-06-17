// 404 — the catch-all route. Mirrors rundan's NotFound card.
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../utils/useDocumentTitle';

export default function NotFound() {
  useDocumentTitle('Hittades inte · Gamedo');
  return (
    <div className="card stack">
      <h1>Hittades inte</h1>
      <p className="muted">Den här sidan finns inte.</p>
      <Link className="btn" to="/events">Tillbaka till evenemang</Link>
    </div>
  );
}
