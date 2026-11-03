import { expect, it } from 'vitest';
import type { TurnView } from '../shared/api';
import { mergeTurnHistory } from './chat-history';

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
