import type { PageSummary, SavedPage } from '../pages';

export function pageSummary(page: SavedPage): PageSummary {
  return { id: page.id, title: page.title, kind: page.kind, headRevisionId: page.headRevisionId, headRevisionNo: page.headRevisionNo,
    freshness: page.freshness, createdAt: page.createdAt, updatedAt: page.updatedAt };
}

// Supported writers advance the accepted revision number; one fixed head can
// only become stale. Wall-clock updatedAt cannot order concurrent responses.
export function newerPage(current: PageSummary | undefined, incoming: PageSummary): PageSummary {
  if (current && (current.headRevisionNo > incoming.headRevisionNo
    || (current.headRevisionNo === incoming.headRevisionNo && current.freshness === 'stale' && incoming.freshness === 'current'))) return current;
  return incoming;
}

export function mergeStudioPages(current: readonly PageSummary[], incoming: readonly PageSummary[]): PageSummary[] {
  const rows = new Map(current.map((page) => [page.id, page]));
  for (const page of incoming) rows.set(page.id, newerPage(rows.get(page.id), page));
  return [...rows.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
