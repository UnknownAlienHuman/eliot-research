import { expect, it } from 'vitest';
import type { TurnView } from '../shared/api';
import { advanceHistoryHead, mergeTurnHistory } from './chat-history';

const turn = (n: number, version = 0): TurnView => ({ turnId: 'turn-' + String(n).padStart(4, '0'), createdAt: Math.floor(n / 100), historyVersion: version,
  question: 'Question ' + n, answer: 'Version ' + version, state: version ? 'completed' : 'started', model: 'fixture', scopeMode: 'empty', revisionIds: [], sourceIds: [],
  citations: [], invalidLabels: 0, inputTokens: null, cachedTokens: null, outputTokens: null, tokenLimit: 0, firstTokenMs: null, totalMs: null, error: null });
it('retains the newer streamed/terminal payload regardless of delayed page or snapshot arrival order', () => {
  const live = turn(90, 4), older = turn(90, 1);
  for (const result of [mergeTurnHistory([live], [older]), mergeTurnHistory([older], [live])]) expect(result).toEqual([live]);
});
it('merges tied timestamps, overlapping pages and a reconnected middle gap in actual chronological order', () => {
  const rows = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, n) => turn(n + start));
  let visible = mergeTurnHistory(rows(1, 100), rows(111, 160));
  expect(visible).toHaveLength(150);
  visible = mergeTurnHistory(visible, rows(61, 110));
  visible = mergeTurnHistory(visible, rows(11, 60));
  expect(visible.map((t) => t.turnId)).toEqual(rows(1, 160).map((t) => t.turnId));
});
it('only advances the boundary for a newer head, bridging disjoint windows while preserving overlapping progress', () => {
  const page = (start: number, end: number) => ({ turns: Array.from({ length: end - start + 1 }, (_, n) => ({ ...turn(n + start), createdAt: 100 })), nextCursor: String(start) });
  const initial = advanceHistoryHead(null, page(51, 100));
  if (!initial) throw new Error('missing initial head');
  expect(initial.rewind).toBe(true);
  const overlap = advanceHistoryHead(initial.head, page(54, 103));
  if (!overlap) throw new Error('missing advancing head');
  expect(overlap.rewind).toBe(false);
  const disconnected = advanceHistoryHead(overlap.head, page(131, 180));
  if (!disconnected) throw new Error('missing gap bridge');
  expect(disconnected.rewind).toBe(true);
  expect(advanceHistoryHead(disconnected.head, page(51, 100))).toBeNull(); // Older socket snapshot after newer HTTP.
  expect(advanceHistoryHead(disconnected.head, page(131, 180))).toBeNull(); // Equal-head replay cannot reset progress.
  const visible = mergeTurnHistory(page(51, 100).turns, page(131, 180).turns);
  const filled = mergeTurnHistory(visible, page(81, 130).turns);
  expect(filled.map((t) => t.turnId)).toEqual(page(51, 180).turns.map((t) => t.turnId));
});
