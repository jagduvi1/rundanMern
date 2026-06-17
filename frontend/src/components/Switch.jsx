// Switch — an on/off toggle for settings-style booleans. Same data shape as a
// checkbox; rendered as a sliding track via the .switch classes in index.css.
//
// Props: { checked, onChange, label, disabled = false, ...rest }
export default function Switch({ checked, onChange, label, disabled = false, ...rest }) {
  return (
    <label className="switch" style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
      <input
        type="checkbox"
        checked={!!checked}
        onChange={onChange}
        disabled={disabled}
        {...rest}
      />
      <span className="track" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </label>
  );
}
