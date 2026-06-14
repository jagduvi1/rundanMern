// RichTextEditor — a tiny WYSIWYG editor for the host "Rules / info" field.
// The React port of rundan's RichTextEditor.razor (+ wwwroot/js/richtext.js). A
// contentEditable div with a bold/italic/underline + bullet/numbered-list toolbar
// (document.execCommand), and a verbatim port of the server-safe `sanitize`
// allow-list run on every read-back. The sanitizer is the security boundary for
// stored HTML — the server MUST also sanitize on save (defense in depth).
//
// Props:
//   value    : string | null — initial HTML (seeded once on mount; afterwards the
//              DOM owns the content so we never re-write innerHTML and disturb the
//              caret).
//   onChange : (html: string) => void — emits the cleaned HTML on input/blur.
//   placeholder : string — shown via the data-placeholder attribute when empty.
import { useEffect, useRef } from 'react';

// Allow-list HTML sanitizer — ported verbatim from richtext.js. Allowed tags carry
// no attributes except <A> (href/target/rel). Unknown elements are unwrapped
// (their text kept); all other attributes stripped; only http(s)/mailto links kept
// and forced to target=_blank rel="noopener noreferrer". Blocks script/style/img/
// iframe/on*.
const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'P', 'BR', 'DIV', 'UL', 'OL', 'LI', 'A']);

export function sanitizeRichText(html) {
  if (!html) return '';
  let doc;
  try {
    doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  } catch {
    return '';
  }
  const body = doc.body;

  const walk = (node) => {
    // Snapshot children first — we mutate the tree as we go.
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === 3) continue; // text node — keep
      if (child.nodeType !== 1) {
        child.remove(); // comments / others
        continue;
      }
      const tag = child.tagName;
      if (!ALLOWED.has(tag)) {
        // Unwrap: splice the (sanitized) children in place of the element.
        walk(child);
        const parent = child.parentNode;
        while (child.firstChild) parent.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }
      // Strip every attribute. Safe <A> hrefs are recovered (from hrefMap, captured
      // before this pass) and re-applied with a forced target/rel below.
      const attrs = Array.from(child.attributes).map((a) => a.name);
      for (const name of attrs) child.removeAttribute(name);
      walk(child);
    }
  };

  // Capture <a href> values before attribute stripping (querySelectorAll keeps order).
  const hrefMap = new Map();
  const originalAnchors = Array.from(body.querySelectorAll('a'));
  originalAnchors.forEach((a, i) => hrefMap.set(i, a.getAttribute('href') || ''));

  walk(body);

  // Re-apply safe hrefs to the surviving anchors (order preserved by querySelectorAll).
  Array.from(body.querySelectorAll('a')).forEach((a, i) => {
    const raw = (hrefMap.get(i) || '').trim();
    const ok = /^(https?:|mailto:)/i.test(raw);
    if (ok) {
      a.setAttribute('href', raw);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('href');
    }
  });

  return body.innerHTML.trim();
}

const COMMANDS = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  bullet: 'insertUnorderedList',
  number: 'insertOrderedList',
};

export default function RichTextEditor({ value, onChange, placeholder = '' }) {
  const elRef = useRef(null);
  const seededRef = useRef(false);

  // Seed the editable once (and re-seed if the bound value changes externally while
  // the editor is NOT focused — e.g. switching to a different record). Never rewrite
  // while focused, which would reset the caret.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (!seededRef.current) {
      el.innerHTML = value || '';
      seededRef.current = true;
      return;
    }
    if (document.activeElement !== el && (value || '') !== el.innerHTML) {
      el.innerHTML = value || '';
    }
  }, [value]);

  const push = () => {
    const el = elRef.current;
    if (!el) return;
    const clean = sanitizeRichText(el.innerHTML);
    if (clean !== (value || '')) onChange?.(clean);
  };

  const cmd = (command) => {
    const el = elRef.current;
    if (!el) return;
    el.focus();
    try {
      document.execCommand(command, false, null);
    } catch {
      /* command unsupported — ignore */
    }
    push();
  };

  // preventDefault on mousedown so the editable keeps its selection when a toolbar
  // button is pressed.
  const tbDown = (e) => e.preventDefault();

  return (
    <div style={rteStyle}>
      <div style={toolbarStyle}>
        <button type="button" style={btnStyle} title="Fet" onMouseDown={tbDown} onClick={() => cmd(COMMANDS.bold)}><b>F</b></button>
        <button type="button" style={btnStyle} title="Kursiv" onMouseDown={tbDown} onClick={() => cmd(COMMANDS.italic)}><i>K</i></button>
        <button type="button" style={btnStyle} title="Understruken" onMouseDown={tbDown} onClick={() => cmd(COMMANDS.underline)}><u>U</u></button>
        <span style={sepStyle} />
        <button type="button" style={btnStyle} title="Punktlista" onMouseDown={tbDown} onClick={() => cmd(COMMANDS.bullet)}>• Lista</button>
        <button type="button" style={btnStyle} title="Numrerad lista" onMouseDown={tbDown} onClick={() => cmd(COMMANDS.number)}>1. Lista</button>
      </div>
      <div
        ref={elRef}
        className="rte-content"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        onInput={push}
        onBlur={push}
        style={areaStyle}
      />
    </div>
  );
}

const rteStyle = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm, 10px)',
  overflow: 'hidden',
  background: 'var(--surface, #fff)',
};
const toolbarStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: 6,
  borderBottom: '1px solid var(--border)',
  background: 'var(--accent-soft, #f3f4f6)',
  flexWrap: 'wrap',
};
const btnStyle = {
  minWidth: 34,
  minHeight: 32,
  padding: '4px 8px',
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--surface, #fff)',
  cursor: 'pointer',
  fontSize: '0.9rem',
};
const sepStyle = { width: 1, alignSelf: 'stretch', background: 'var(--border)', margin: '0 2px' };
const areaStyle = {
  minHeight: 120,
  padding: '10px 12px',
  outline: 'none',
  lineHeight: 1.55,
};
