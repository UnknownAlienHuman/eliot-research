import { useCallback, useRef } from 'react';

/**
 * Shared, identity-keyed commit reporter for panels that must notify a root consumer exactly once per
 * accepted canonical mutation.
 *
 * The key is the caller's canonical identity, never a click, a render, a network attempt or a timestamp,
 * so the same commit observed again through a reconciliation, a repeated status read or a re-render
 * reports once. A key that never appears reports nothing.
 *
 * The dedupe set lives for the mounted lifetime of the panel, so a remount that carries a new consumer
 * request can report again, while a re-render of the same mounted panel cannot.
 */
export function useCanonicalCommitReport(notify?: () => void): (key: string) => void {
  const reported = useRef<ReadonlySet<string>>(new Set());
  return useCallback((key: string) => {
    if (notify === undefined || reported.current.has(key)) return;
    reported.current = new Set([...reported.current, key]);
    notify();
  }, [notify]);
}
