import { describe, expect, it } from 'vitest';
import type { ResearchRunHistoryView } from '@eliotr/owner-api-client';
import { savedReportTitle, studioSavedReports } from './StudioPanel';

describe('saved report history titles', () => {
  it('shows the saved question and normalizes display whitespace', () => {
    expect(savedReportTitle('  Why   did the result change?  ', 'en')).toBe('Why did the result change?');
  });

  it('uses localized fallback labels when a saved draft has no verified workflow question', () => {
    expect(savedReportTitle(undefined, 'en')).toBe('Research report');
    expect(savedReportTitle(undefined, 'ru')).toBe('Отчёт исследования');
  });

  it('merges saved drafts with verified completed-run reports, deduplicates and keeps timestamp meanings', () => {
    const savedRef = { id: 'artifact-saved', revision: 1 };
    const fallbackRef = { id: 'artifact-fallback', revision: 2 };
    const history = {
      protocol: 'eliotr.research-runs.v6',
      saved_drafts: [{ artifact_ref: savedRef, created_at: '2026-10-17T12:00:00.000Z' }],
      runs: [
        { created_at: '2026-10-17T12:30:00.000Z', query: 'An uncompleted run', status: {
          execution_state: 'ACTIVE', answer: { availability: 'unavailable' },
        } },
        { created_at: '2026-10-17T11:00:00.000Z', query: 'The saved report question', status: {
          execution_state: 'ENGINE_COMPLETED', answer: { availability: 'draft', artifact_ref: savedRef },
        } },
        { created_at: '2026-10-17T10:00:00.000Z', query: 'The fallback report question', status: {
          execution_state: 'ENGINE_COMPLETED', answer: { availability: 'draft', artifact_ref: fallbackRef },
        } },
      ],
    } as unknown as ResearchRunHistoryView;

    expect(studioSavedReports(history)).toEqual([
      { artifact_ref: savedRef, created_at: '2026-10-17T12:00:00.000Z',
        query: 'The saved report question', date_source: 'artifact' },
      { artifact_ref: fallbackRef, created_at: '2026-10-17T10:00:00.000Z',
        query: 'The fallback report question', date_source: 'run' },
    ]);
  });

  it('bounds the combined recent report rows to eight', () => {
    const history = {
      protocol: 'eliotr.research-runs.v6',
      saved_drafts: Array.from({ length: 8 }, (_unused, index) => ({ artifact_ref: { id: `draft-${index}`, revision: 1 },
        created_at: `2026-10-17T12:${String(8 - index).padStart(2, '0')}:00.000Z` })),
      runs: Array.from({ length: 8 }, (_unused, index) => ({ created_at: `2026-10-17T11:${String(8 - index).padStart(2, '0')}:00.000Z`,
        status: { execution_state: 'ENGINE_COMPLETED', answer: { availability: 'draft',
          artifact_ref: { id: `fallback-${index}`, revision: 1 } } } })),
    } as unknown as ResearchRunHistoryView;
    expect(studioSavedReports(history)).toHaveLength(8);
  });
});
