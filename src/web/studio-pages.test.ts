import { expect, it } from 'vitest';
import type { PageSummary } from '../pages';
import { mergeStudioPages, newerPage } from './studio-pages';

const page = (id: string, headRevisionNo = 1, freshness: PageSummary['freshness'] = 'current'): PageSummary => ({ id, title: id, kind: 'note',
  headRevisionId: id + '-head-' + headRevisionNo, headRevisionNo, freshness, createdAt: 100, updatedAt: 100 });
it('does not let an older head or delayed current response undo a newer accepted/stale projection', () => {
  const stale = page('a', 1, 'stale'), newer = page('a', 2);
  expect(newerPage(stale, page('a'))).toBe(stale);
  expect(newerPage(stale, newer)).toBe(newer);
  expect(newerPage(newer, stale)).toBe(newer);
  expect(newerPage(stale, { ...page('a'), updatedAt: 9999 })).toBe(stale);
});
it('deduplicates reordered and overlapping pages in the immutable descending creation/ID order', () => {
  const rows = mergeStudioPages([page('b'), page('a', 2)], [page('a'), page('c'), page('b', 1, 'stale')]);
  expect(rows.map((p) => p.id)).toEqual(['c', 'b', 'a']); expect(rows[1]?.freshness).toBe('stale'); expect(rows[2]?.headRevisionNo).toBe(2);
  expect(mergeStudioPages(rows, [{ ...page('new'), createdAt: 101 }])[0]?.id).toBe('new');
});
