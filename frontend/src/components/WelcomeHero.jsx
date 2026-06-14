// WelcomeHero — friendly landing hero with the app name + a primary CTA.
// The React port of rundan's WelcomeHero.razor (a pure presentational banner),
// generalised to take the app name and an action callback as props.
//
// Props:
//   appName : string  — shown as the big title (falls back to "Rundan").
//   onAction: () => void — primary CTA handler. When omitted the button hides.
//   actionLabel?: string — CTA text (default "Kom igång").

const heroStyle = {
  background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%)',
  color: '#fff',
  borderColor: 'transparent',
};

export default function WelcomeHero({ appName = 'Rundan', onAction, actionLabel = 'Kom igång' }) {
  return (
    <div className="card hero stack center" style={heroStyle}>
      <div
        aria-hidden="true"
        style={{
          width: 64,
          height: 64,
          margin: '0 auto',
          borderRadius: 18,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(255,255,255,.18)',
          fontSize: '2rem',
        }}
      >
        🎉
      </div>
      <h1 style={{ margin: 0, color: '#fff' }}>Välkommen till {appName}</h1>
      <p style={{ color: 'rgba(255,255,255,.9)', margin: 0 }}>
        En dag ute med ditt gäng — tipspromenader, lekar och en gemensam poängtavla.
      </p>
      {onAction ? (
        <button
          className="btn"
          onClick={onAction}
          style={{ background: '#fff', color: 'var(--accent-dark)', alignSelf: 'center', marginTop: 4 }}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
