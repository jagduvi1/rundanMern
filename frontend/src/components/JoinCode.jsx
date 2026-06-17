// JoinCode — the prominent short code guests type (or scan) to enter an event or
// activity. Big, letter-spaced and tabular so every glyph lines up. A thin wrapper
// over the .joincode classes in index.css.
//
// Props: { code, size = 'lg' | 'md' | 'sm', block = false, className, ...rest }
export default function JoinCode({ code, size = 'lg', block = false, className = '', ...rest }) {
  const cls = ['joincode', size, block ? 'block' : '', className].filter(Boolean).join(' ');
  return (
    <span className={cls} {...rest}>
      {code}
    </span>
  );
}
