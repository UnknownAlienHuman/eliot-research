import type { LibraryPage } from '@eliotr/owner-api-client';

type CatalogData = Pick<LibraryPage, 'projects' | 'sources' | 'next_cursor'>;

/** Synthetic catalog transport only; empty channels retain unknown recorded readiness. */
export function withRecordedCatalogReadiness(url: URL, data: CatalogData, observedAt: string): CatalogData {
  if (url.searchParams.get('readiness') !== 'recorded-v1') return data;
  return { ...data, sources: data.sources.map(source => {
    const prefix = `readiness:${source.id}:`;
    if (!source.readiness_ref.startsWith(prefix)) throw new Error('Preview catalog readiness must name its exact source head');
    return { ...source, readiness_summary: {
      protocol: 'eliotr.library-row-readiness.v1', source_revision_ref: source.readiness_ref.slice(prefix.length),
      basis: 'RECORDED_ONLY', scope: 'SOURCE_PROJECTION', quality_state: 'standard', observed_at: observedAt, channels: [],
    } };
  }) };
}
