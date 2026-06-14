// A small status pill. `kind` maps to the .pill colour variants in index.css:
//   accent (blue) · ok (green) · warn (amber) · live (red). Omit for the neutral
// default.
export default function Pill({ kind, children, className = '', ...rest }) {
  const cls = ['pill', kind, className].filter(Boolean).join(' ');
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}
