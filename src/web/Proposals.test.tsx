// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProposalsInbox } from './Proposals';

const revisionId = '11111111-1111-4111-8111-111111111111';
const label = `[R${revisionId}:14]`;
const target = `/p/p1/source/s1?revisionId=${revisionId}&start=9&end=28`;
const proposal = { revisionId: 'draft1', pageId: 'page1', title: 'Cited draft', kind: 'note', status: 'proposed',
  actor: 'agent', createdAt: 0, headRevisionId: null, baseRevisionId: null, body: `Read this evidence ${label}.`, revisionIds: [revisionId],
  citations: [{ revisionId, sourceId: 's1', sourceTitle: 'Русский источник', block: 14, start: 9, end: 28, deleted: false, label }] };
let root: Root, host: HTMLDivElement, router: ReturnType<typeof createMemoryRouter>;
let readerArrival: boolean[];
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function ReaderArrival() {
  const location = useLocation();
  // The actual Reader focuses its selected passage in a passive effect. The
  // proposal must already have released the modal focus trap at that point.
  useEffect(() => {
    if (location.pathname.includes('/source/')) readerArrival.push(host.querySelector('dialog')?.open ?? false);
  }, [location.key, location.pathname]);
  return null;
}
function Workspace() { return <><ReaderArrival /><ProposalsInbox projectId='p1' /></>; }
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function click(element: HTMLElement) { await act(async () => { element.click(); }); await settle(); }
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === text);
  if (!found) throw new Error('Missing button: ' + text);
  return found;
}
function element<T extends HTMLElement>(selector: string): T {
  const found = host.querySelector<T>(selector);
  if (!found) throw new Error('Missing element: ' + selector);
  return found;
}
const dialog = () => element<HTMLDialogElement>('dialog');
async function open() {
  router = createMemoryRouter([{ path: '/p/:projectId/*', element: <Workspace /> }], { initialEntries: ['/p/p1/studio'] });
  await act(async () => { root.render(<RouterProvider router={router} />); }); await settle();
  await click(button('Agent proposals (1)'));
  await click(element<HTMLButtonElement>('.er-proposals__open'));
  expect(dialog().open).toBe(true);
  expect(host.querySelector('.er-proposals__markdown')?.textContent).toContain('Read this evidence');
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.setAttribute('open', ''); } },
    close: { configurable: true, value() { this.removeAttribute('open'); } },
  });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); readerArrival = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET');
    const url = String(input);
    if (url === '/api/projects/p1/proposals') return json({ proposals: [proposal], nextCursor: null });
    if (url === '/api/projects/p1/proposals/draft1') return json({ proposal });
    throw new Error('Unexpected request: ' + url);
  }));
});
afterEach(async () => { await act(async () => root.unmount()); router?.dispose(); host.remove(); vi.unstubAllGlobals(); });

describe('Proposal citation navigation', () => {
  it.each(['.er-proposals__markdown a', 'details a'])('releases the modal before opening the exact citation from %s', async selector => {
    await open();
    const citation = element<HTMLAnchorElement>(selector);
    expect(citation.getAttribute('href')).toBe(target);
    await click(citation);
    expect(router.state.location.pathname + router.state.location.search).toBe(target);
    expect(dialog().open).toBe(false);
    expect(readerArrival).toEqual([false]);
    await click(button('Agent proposals (1)'));
    expect(dialog().open).toBe(true);
    expect(host.querySelector('.er-proposals__markdown')?.textContent).toContain('Read this evidence');
    expect(host.querySelector('.er-proposals__open')?.getAttribute('aria-pressed')).toBe('true');
    // Reopening the same citation still dismisses the review; no proposal is accepted.
    await click(element<HTMLAnchorElement>(selector));
    expect(dialog().open).toBe(false);
    expect(router.state.location.pathname + router.state.location.search).toBe(target);
    expect(readerArrival).toEqual([false, false]);
  });

  it.each(['ctrlKey', 'metaKey'] as const)('keeps the proposal open when a citation is opened with %s', async modifier => {
    await open();
    // Suppress jsdom's unimplemented new-tab default, after React's Link handler.
    document.addEventListener('click', event => event.preventDefault(), { once: true });
    await act(async () => {
      element<HTMLAnchorElement>('.er-proposals__markdown a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true }));
    }); await settle();
    expect(router.state.location.pathname).toBe('/p/p1/studio');
    expect(dialog().open).toBe(true);
    expect(readerArrival).toEqual([]);
  });
});
