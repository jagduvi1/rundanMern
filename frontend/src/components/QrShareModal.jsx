// A share modal that renders a QR code for `url` plus the url/join code and a
// copy button. Uses the `qrcode` package (QRCode.toDataURL → a PNG data URL).
// Renders nothing when `open` is false; closes on backdrop click or Escape.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export default function QrShareModal({ open, url, title = 'Dela', onClose }) {
  const [dataUrl, setDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);

  // Generate the QR whenever the modal opens for a given url.
  useEffect(() => {
    if (!open || !url) {
      setDataUrl('');
      return undefined;
    }
    let cancelled = false;
    setError(null);
    QRCode.toDataURL(url, { width: 240, margin: 1 })
      .then((d) => {
        if (!cancelled) setDataUrl(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || 'Kunde inte skapa QR-kod.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, url]);

  // Reset the transient "copied" state and close on Escape.
  useEffect(() => {
    if (!open) return undefined;
    setCopied(false);
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // Fallback for non-secure contexts without the async clipboard API.
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the url is visible to copy manually */
    }
  };

  return (
    <div style={overlay} onClick={onClose} role="presentation">
      <div
        className="card center"
        style={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        {error ? (
          <p className="error-text">{error}</p>
        ) : dataUrl ? (
          <img
            src={dataUrl}
            alt="QR-kod"
            width={240}
            height={240}
            style={{ margin: '0 auto', maxWidth: '100%' }}
          />
        ) : (
          <span className="spinner" role="status" aria-label="Skapar QR-kod" />
        )}

        <div
          className="small muted"
          style={{ wordBreak: 'break-all', margin: '12px 0' }}
        >
          {url}
        </div>

        <div className="row" style={{ justifyContent: 'center' }}>
          <button type="button" className="btn soft" onClick={copy}>
            {copied ? 'Kopierad!' : 'Kopiera länk'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Stäng
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
  maxWidth: '360px',
  boxShadow: '0 10px 40px rgba(20, 30, 60, 0.14)',
};
