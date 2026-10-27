import { describe, expect, it } from 'vitest';
import { buildComparisons, normalizeComparisonText, normalizeConditionKey, parseComparisonScalar } from './comparisons.js';
import type { ComparisonClaim } from './comparisons.js';
let n = 0;
function claim(partial: Partial<ComparisonClaim> & { sourceId: string }): ComparisonClaim {
  n += 1;
  return {
    id: 'c' + n, revisionId: 'r-' + partial.sourceId, kind: 'result',
    statement: 's', quote: 'q ' + n, block: 1, start: 0, end: 10,
    ambiguous: false, task: 'task', metric: 'metric', dataset: 'data',
    valueText: '1 unit', valueNumber: 1, unit: 'unit', conditions: 'cond',
    ...partial,
  };
}
function two(taskA: Partial<ComparisonClaim>, taskB: Partial<ComparisonClaim>) {
  return buildComparisons([
    claim({ sourceId: 's1', ...taskA }),
    claim({ sourceId: 's2', ...taskB }),
  ]);
}
describe('normalizeComparisonText', () => {
  it('folds unicode case and punctuation', () => {
    expect(normalizeComparisonText('  ImageNet—TOP-1! ')).toBe('imagenet top 1');
    expect(normalizeComparisonText('БЕРТ  base')).toBe('берт base');
  });
});
describe('parseComparisonScalar', () => {
  it('parses decimals and scientific notation', () => {
    expect(parseComparisonScalar('28,4 BLEU')).toEqual({ value: 28.4, unit: 'bleu' });
    expect(parseComparisonScalar('1.2e3')).toEqual({ value: 1200, unit: '' });
    expect(parseComparisonScalar('3,57%')).toEqual({ value: 3.57, unit: 'percent' });
  });
  it('rejects unsafe text', () => {
    expect(parseComparisonScalar('')).toBeNull();
    expect(parseComparisonScalar('no number here')).toBeNull();
    expect(parseComparisonScalar('two 3 values 4')).toBeNull();
    expect(parseComparisonScalar('3 and 5')).toBeNull();
    expect(parseComparisonScalar('>3')).toBeNull();
    expect(parseComparisonScalar('3 5')).toBeNull();
    expect(parseComparisonScalar('28.4 BLEU or five')).toBeNull();
    expect(parseComparisonScalar('28.4 BLEU or 5')).toBeNull();
    expect(parseComparisonScalar('3 to 5')).toBeNull();
    expect(parseComparisonScalar('≤3')).toBeNull();
    expect(parseComparisonScalar('1,234')).toBeNull();
    expect(parseComparisonScalar('1,234.5')).toBeNull();
    expect(parseComparisonScalar('1,234,567')).toBeNull();
    expect(parseComparisonScalar('1 234 567')).toEqual({ value: 1234567, unit: '' });
    expect(parseComparisonScalar('1_234_567')).toEqual({ value: 1234567, unit: '' });
    expect(parseComparisonScalar('1_234 567')).toBeNull();
    expect(parseComparisonScalar('12 34')).toBeNull();
    expect(parseComparisonScalar('1000')).toEqual({ value: 1000, unit: '' });
  });
  it('does not concatenate two spaced numbers into a comparison value', () => {
    const g = two(
      { valueText: '3 5', valueNumber: 35, unit: 'BLEU' },
      { valueText: '35', valueNumber: 35, unit: 'BLEU' },
    );
    expect(g).toHaveLength(0);
  });
  it('does not turn prose after an inline unit into a supported scalar', () => {
    const g = two(
      { valueText: '28.4 BLEU or five', valueNumber: 28.4, unit: 'BLEU' },
      { valueText: '28.4 BLEU', valueNumber: 28.4, unit: 'BLEU' },
    );
    expect(g).toHaveLength(0);
  });
  it('does not accept a second numeric value after an inline unit', () => {
    const g = two(
      { valueText: '28.4 BLEU or 5', valueNumber: 28.4, unit: 'BLEU' },
      { valueText: '28.4 BLEU', valueNumber: 28.4, unit: 'BLEU' },
    );
    expect(g).toHaveLength(0);
  });
});
describe('buildComparisons', () => {
  it('groups two compatible sources, quotes retained', () => {
    const g = two({ valueText: '28,4 BLEU', valueNumber: 28.4, unit: 'BLEU' }, { valueText: '28,4 BLEU', valueNumber: 28.4, unit: 'BLEU' });
    expect(g).toHaveLength(1);
    expect(g[0]?.rows).toHaveLength(2);
    expect(g[0]?.disagreement).toBe(false);
    expect(g[0]?.rows[0]?.quote).not.toBe(g[0]?.rows[1]?.quote);
  });
  it('marks different numbers as disagreement candidates', () => {
    const g = two({ valueText: '28,4 BLEU', valueNumber: 28.4, unit: 'BLEU' }, { valueText: '41,8 BLEU', valueNumber: 41.8, unit: 'BLEU' });
    expect(g).toHaveLength(1);
    expect(g[0]?.disagreement).toBe(true);
  });
  it('excludes unit mismatch', () => {
    const g = two({ valueText: '28,4 BLEU', valueNumber: 28.4, unit: 'BLEU' }, { valueText: '28,4 %', valueNumber: 28.4, unit: '%' });
    expect(g).toHaveLength(0);
  });
  it('excludes dataset mismatch', () => {
    const g = two({ dataset: 'wmt14-en-de' }, { dataset: 'wmt14-en-fr' });
    expect(g).toHaveLength(0);
  });
  it('excludes condition mismatch', () => {
    const g = two({ conditions: 'base, 8 gpu' }, { conditions: 'large, 8 gpu' });
    expect(g).toHaveLength(0);
  });
  it('excludes ambiguous, non-result and incomplete facts', () => {
    const g = buildComparisons([
      claim({ sourceId: 's1', ambiguous: true }),
      claim({ sourceId: 's2', kind: 'method' }),
      claim({ sourceId: 's3', valueNumber: null }),
      claim({ sourceId: 's4', unit: null }),
    ]);
    expect(g).toHaveLength(0);
  });
  it('requires two distinct sources, no same-source duplicate pass', () => {
    const same = buildComparisons([claim({ sourceId: 's1' }), claim({ sourceId: 's1', quote: 'other' })]);
    expect(same).toHaveLength(0);
    const dup = buildComparisons([claim({ sourceId: 's1' }), claim({ sourceId: 's2' }), claim({ sourceId: 's1' })]);
    expect(dup).toHaveLength(0);
  });
  it('keeps conditions strict, aliases only normalize task synonyms', () => {
    const g = buildComparisons(
      [
        claim({ sourceId: 's1', task: 'machine translation' }),
        claim({ sourceId: 's2', task: 'MT' }),
      ],
      { 'machine translation': ['mt'] },
    );
    expect(g).toHaveLength(1);
    const strict = buildComparisons([
      claim({ sourceId: 's1', task: 'machine translation' }),
      claim({ sourceId: 's2', task: 'MT' }),
    ]);
    expect(strict).toHaveLength(0);
  });
  it('aliases never override unit incompatibility', () => {
    const g = buildComparisons(
      [
        claim({ sourceId: 's1', task: 'MT', valueText: '28,4 BLEU', valueNumber: 28.4, unit: 'BLEU' }),
        claim({ sourceId: 's2', task: 'machine translation', valueText: '28,4 %', valueNumber: 28.4, unit: '%' }),
      ],
      { 'machine translation': ['mt'] },
    );
    expect(g).toHaveLength(0);
  });
  it('groups bare scalar plus explicit separate unit', () => {
    const g = two({ valueText: '28.4', valueNumber: 28.4, unit: 'BLEU' }, { valueText: '28.4', valueNumber: 28.4, unit: 'BLEU' });
    expect(g).toHaveLength(1);
    expect(g[0]?.disagreement).toBe(false);
    expect(g[0]?.unit).toBe('BLEU');
  });
  it('rejects conflicting inline versus explicit unit', () => {
    const g = two({ valueText: '28,4 BLEU', valueNumber: 28.4, unit: '%' }, { valueText: '28,4 BLEU', valueNumber: 28.4, unit: 'BLEU' });
    expect(g).toHaveLength(0);
  });
  it('keeps comparator meaning in condition keys', () => {
    expect(normalizeConditionKey('> 8 gpu')).not.toBe(normalizeConditionKey('< 8 gpu'));
    expect(normalizeConditionKey('≥ 8 GPU')).not.toBe(normalizeConditionKey('≤ 8 GPU'));
    const g = two({ conditions: '> 8 gpu' }, { conditions: '< 8 gpu' });
    expect(g).toHaveLength(0);
  });
  it('keeps interval open/closed semantics distinct', () => {
    expect(normalizeConditionKey('x in [0,1)')).not.toBe(normalizeConditionKey('x in (0,1]'));
    const g = two({ conditions: 'x in [0,1)' }, { conditions: 'x in (0,1]' });
    expect(g).toHaveLength(0);
  });
  it('preserves braces and distinguishes set braces from interval brackets', () => {
    expect(normalizeConditionKey('x in {0, 1}')).not.toBe(normalizeConditionKey('x in [0, 1]'));
    expect(normalizeConditionKey('x in {0, 1}')).toBe(normalizeConditionKey('x in {0,1}'));
    const g = two({ conditions: 'x in {0, 1}' }, { conditions: 'x in [0, 1]' });
    expect(g).toHaveLength(0);
  });
  it('keeps conditional-probability pipe distinct from juxtaposition', () => {
    expect(normalizeConditionKey('P(A|B)')).not.toBe(normalizeConditionKey('P(AB)'));
    const g = two({ conditions: 'P(A|B)' }, { conditions: 'P(AB)' });
    expect(g).toHaveLength(0);
  });
  it('treats equivalent bracket spacing as the same condition', () => {
    expect(normalizeConditionKey('x in [0, 1)')).toBe(normalizeConditionKey('x in [0,1)'));
    const g = two({ conditions: 'x in [0, 1)' }, { conditions: 'x in [0,1)' });
    expect(g).toHaveLength(1);
  });
  it('retains exact quotes and offsets untouched', () => {
    const a = claim({ sourceId: 's1', quote: 'exact 28,4', block: 7, start: 100, end: 200, valueText: '28,4 BLEU', valueNumber: 28.4, unit: 'BLEU' });
    const b = claim({ sourceId: 's2', quote: 'exact 28,4', block: 9, start: 300, end: 400, valueText: '28,4 BLEU', valueNumber: 28.4, unit: 'BLEU' });
    const g = buildComparisons([a, b]);
    expect(g[0]?.rows.map((r) => [r.block, r.start, r.end])).toEqual([[7, 100, 200], [9, 300, 400]]);
  });
});
