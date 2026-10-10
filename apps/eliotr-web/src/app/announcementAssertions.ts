/** DOM-level announcement checks; physical screen-reader behavior is outside this fixture. */
export function paneAnnouncement(root: HTMLElement): HTMLElement {
  const regions = root.querySelectorAll('[role="status"], [aria-live], [role="alert"]');
  if (regions.length !== 1 || !(regions[0] instanceof HTMLElement)) throw new Error('A pane must have exactly one operation announcement channel');
  const region = regions[0];
  if (region.getAttribute('role') !== 'status' || region.getAttribute('aria-live') !== 'polite' || region.getAttribute('aria-atomic') !== 'true') throw new Error('Operation announcement semantics changed');
  return region;
}
export async function announcementUntil(check: () => boolean, detail?: () => string): Promise<void> {
  for (let count = 0; count < 120; count++) {
    if (check()) return;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  throw new Error('Operation announcement did not settle' + (detail ? ': ' + detail() : ''));
}
export function unchangedChannel(root: HTMLElement, previous: HTMLElement, message: string): boolean {
  return paneAnnouncement(root) === previous && previous.textContent === message;
}
