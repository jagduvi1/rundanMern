// A simple confirm modal. Renders nothing when `open` is false. Closes on backdrop
// click or Escape (both treated as cancel). Reuses .card / .btn classes.
import { useEffect } from 'react';

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Bekräfta',
  cancelLabel = 'Avbryt',
  danger = false,
  onConfirm,
  onCancel,
}) {
  // Close on Escape while open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      style={overlay}
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="card"
        style={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Bekräfta'}
        onClick={(e) => e.stopPropagation()}
      >
        {title ? <h2 style={{ marginTop: 0 }}>{title}</h2> : null}
        {message ? <p className="muted" style={{ marginTop: 0 }}>{message}</p> : null}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="btn ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'btn danger' : 'btn'}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(10, 15, 30, 0.5)',
  display: 'grid',
  placeItems: 'center',
  padding: '16px',
  zIndex: 200,
};

const dialog = {
  width: '100%',
  maxWidth: '420px',
  boxShadow: '0 10px 40px rgba(20, 30, 60, 0.14)',
};
