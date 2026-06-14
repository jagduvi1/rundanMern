// Sets document.title for the lifetime of the calling component and restores the
// previous title on unmount. A lightweight alternative to react-helmet for simple
// per-page titles.
import { useEffect } from 'react';

export function useDocumentTitle(title) {
  useEffect(() => {
    if (typeof document === 'undefined' || !title) return undefined;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
