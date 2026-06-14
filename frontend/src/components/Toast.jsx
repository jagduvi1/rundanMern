// Transient toast hook. `show(msg)` displays a single .toast (index.css) for ~2.5s;
// `toast` is JSX to render somewhere in the tree (or null when nothing is showing).
//
//   const { toast, show } = useToast();
//   return (<>{toast}<button onClick={() => show('Sparat!')}>…</button></>);
import { useCallback, useEffect, useRef, useState } from 'react';

const DURATION = 2500;

export function useToast() {
  const [message, setMessage] = useState(null);
  const timer = useRef(null);

  const show = useCallback((msg) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(msg);
    timer.current = setTimeout(() => {
      setMessage(null);
      timer.current = null;
    }, DURATION);
  }, []);

  // Clear the pending timer if the consumer unmounts mid-toast.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const toast = message ? (
    <div className="toast" role="status" aria-live="polite">
      {message}
    </div>
  ) : null;

  return { toast, show };
}
