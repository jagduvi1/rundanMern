// Loading indicators — reuse the .spinner / .loading-page classes from index.css.
export default function Spinner() {
  return <span className="spinner" role="status" aria-label="Laddar" />;
}

// Full-height centered loading state for whole-page / route-level loads.
export function LoadingPage({ label = 'Laddar…' }) {
  return (
    <div className="loading-page">
      <span className="spinner" role="status" aria-label={label} />
      {label ? <div className="muted">{label}</div> : null}
    </div>
  );
}
