import { useEffect, useRef, useState } from 'react';

/** The pane starts quiet, including cached facts. Only subsequent operation changes announce.
 * Shell removes the pane synchronously on authority loss and keys new contexts by cache epoch.
 * This text is ephemeral presentation state; it never enters protected Query memory or storage.
 */
export function usePaneAnnouncement(message: string): string {
  const previous = useRef(message);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (previous.current === message) return;
    previous.current = message;
    setAnnouncement(message);
  }, [message]);
  return announcement;
}
