// K6 comparison candidates (pure, bounded, no inference).
// Contract: MAP K6 item 3 + IMPLEMENTATION section 12.
// Code-only grouping: NFKC/lowercase/whitespace/punctuation, parsed
// numeric value/unit, conservative task/metric/dataset/conditions compat.
// Exact quotes/offsets/source facts preserved; no invented numerics.
// Different numbers inside a compatible group are disagreement CANDIDATES.
export interface ComparisonClaim {
  readonly id: string;
  readonly sourceId: string;
  readonly revisionId: string;
  readonly kind: string;
  readonly statement: string;
  readonly quote: string;
  readonly block: number;
  readonly start: number;
  readonly end: number;
  readonly ambiguous: boolean;
  readonly task: string | null;
  readonly metric: string | null;
  readonly dataset: string | null;
  readonly valueText: string | null;
  readonly valueNumber: number | null;
  readonly unit: string | null;
  readonly conditions: string | null;
}
export interface ComparisonGroup {
  readonly id: string;
  readonly task: string;
  readonly metric: string;
  readonly dataset: string;
  readonly unit: string;
  readonly conditions: string;
  readonly rows: ComparisonClaim[];
  readonly disagreement: boolean;
}
export type ComparisonAliases = Readonly<Record<string, readonly string[]>>;
export function normalizeComparisonText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
const CONDITION_KEEP = new Set(['+', '-', '%', '/', '<', '>', '=', '~', '^', '×', '·', '.', ',', '[', ']', '(', ')', '{', '}', '|', '\u2264', '\u2265', '\u2260', '\u2248', '\u00b1', '-']);
/**
 * Grouping-key normalization that keeps numeric comparators, interval
 * brackets and the conditional-probability pipe distinct.
 * A per-character callback keeps an explicit operator set; no regex set
 * intersection (invalid in /u mode) and no /v flag dependency.
 */
export function normalizeConditionKey(value: string): string {
  const lowered = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/÷/g, '/');
  const kept = [...lowered]
    .map((ch) => {
      if (/[\p{L}\p{N}\s]/u.test(ch) || CONDITION_KEEP.has(ch)) return ch;
      return ' ';
    })
    .join('')
    .replace(/([[\](){},|])\s+/g, '$1')
    .replace(/\s+([[\](){},|])/g, '$1');
  return kept.replace(/\s+/g, ' ').trim();
}
export interface ParsedScalar { readonly value: number; readonly unit: string; }
const UNIT_ALIASES: Readonly<Record<string, string>> = { '%': 'percent', percent: 'percent', percentage: 'percent', pp: 'pp', bleu: 'bleu', f1: 'f1', em: 'em' };
function canonicalUnit(raw: string): string {
  const direct = raw.normalize('NFKC').trim().toLowerCase();
  if (direct in UNIT_ALIASES) return UNIT_ALIASES[direct] as string;
  const key = normalizeComparisonText(raw);
  return UNIT_ALIASES[key] ?? key;
}
// A scalar may use a decimal dot or comma, but grouping uses only spaces or
// underscores in consistent groups of three. Comma-grouped thousands are
// rejected because "1,234" cannot be distinguished from decimal comma.
// The end anchor is intentional: values contain one scalar and an optional
// unit, never a range or arbitrary prose following a number.
const THOUSANDS_SEPARATOR = '[ _\\u00a0\\u2009]';
const NUMBER_RE = new RegExp(
  `^(?<sign>[+-]?)(?<int>(?:\\d{1,3}(?<groupSep>${THOUSANDS_SEPARATOR})\\d{3}(?:\\k<groupSep>\\d{3})*|\\d+))` +
  `(?:(?<decimalSeparator>[.,])(?<fraction>\\d+))?` +
  `(?:[eE](?<expSign>[+-]?)(?<exp>\\d+))?` +
  `(?:[ \\u00a0\\u2009]*(?<unit>%|[a-zA-Z\\u00b5\\u03bc\\u00b0\\u03a9]+))?$`,
  'u',
);
export function parseComparisonScalar(valueText: string): ParsedScalar | null {
  const text = valueText.normalize('NFKC').trim();
  if (text === '') return null;
  const match = NUMBER_RE.exec(text);
  if (!match || !match.groups) return null;
  const rawInt = match.groups.int ?? '';
  const decimalSeparator = match.groups.decimalSeparator ?? '';
  const fraction = match.groups.fraction ?? '';
  const grouped = match.groups.groupSep !== undefined;
  if (decimalSeparator === ',' && !grouped && /^\d{1,3}$/.test(rawInt) && fraction.length === 3) return null;
  const intPart = rawInt.replace(/[ _\u00a0\u2009]/g, '');
  const head = intPart + (fraction === '' ? '' : '.' + fraction);
  if (!/^\d+(\.\d+)?$/.test(head)) return null;
  let value = Number(head);
  if (!Number.isFinite(value)) return null;
  if (match.groups.sign === '-') value = -value;
  const exp = match.groups.exp;
  if (exp !== undefined && exp !== '') {
    const power = Number((match.groups.expSign ?? '') + exp);
    if (!Number.isSafeInteger(power) || Math.abs(power) > 308) return null;
    value = value * 10 ** power;
    if (!Number.isFinite(value)) return null;
  }
  const unitRaw = match.groups.unit ?? '';
  return { value: value, unit: unitRaw === '' ? '' : canonicalUnit(unitRaw) };
}
function aliasKey(value: string, aliases?: ComparisonAliases): string {
  const key = normalizeComparisonText(value);
  if (!aliases) return key;
  for (const entry of Object.entries(aliases)) {
    const canon = normalizeComparisonText(entry[0]);
    if (key === canon) return canon;
    for (const variant of entry[1]) {
      if (key === normalizeComparisonText(variant)) return canon;
    }
  }
  return key;
}
interface ComparableRow {
  readonly claim: ComparisonClaim;
  readonly taskKey: string;
  readonly metricKey: string;
  readonly datasetKey: string;
  readonly unit: string;
  readonly conditionsKey: string;
  readonly value: number;
}
function toComparable(claim: ComparisonClaim, aliases?: ComparisonAliases): ComparableRow | null {
  if (claim.ambiguous) return null;
  if (claim.kind !== 'result') return null;
  if (claim.task === null || claim.metric === null || claim.dataset === null || claim.conditions === null || claim.unit === null || claim.valueNumber === null) return null;
  const valueText = claim.valueText;
  if (valueText === null || normalizeComparisonText(valueText) === '') return null;
  const parsed = parseComparisonScalar(valueText);
  if (!parsed) return null;
  const inlineUnit = parsed.unit;
  const explicitUnit = canonicalUnit(claim.unit);
  if (inlineUnit !== '' && explicitUnit !== inlineUnit) return null;
  const effectiveUnit = inlineUnit !== '' ? inlineUnit : explicitUnit;
  if (effectiveUnit === '') return null;
  if (!Number.isFinite(claim.valueNumber)) return null;
  const rel = Math.abs(claim.valueNumber) <= 1 ? 1e-9 : Math.abs(claim.valueNumber) * 1e-9;
  if (Math.abs(claim.valueNumber - parsed.value) > rel) return null;
  if (normalizeComparisonText(claim.task) === '') return null;
  if (normalizeComparisonText(claim.metric) === '') return null;
  if (normalizeComparisonText(claim.dataset) === '') return null;
  if (normalizeConditionKey(claim.conditions) === '') return null;
  if (normalizeComparisonText(claim.quote) === '') return null;
  return { claim: claim, taskKey: aliasKey(claim.task, aliases), metricKey: aliasKey(claim.metric, aliases), datasetKey: normalizeComparisonText(claim.dataset), unit: effectiveUnit, conditionsKey: normalizeConditionKey(claim.conditions), value: parsed.value };
}
function distinctSources(rows: ComparableRow[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) { seen.add(row.claim.sourceId); if (seen.size > 1) return true; }
  return false;
}
function sameSourceDuplicate(rows: ComparableRow[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.claim.sourceId + ' ' + row.claim.block + ' ' + row.claim.start + ' ' + row.claim.end;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}
export function buildComparisons(claims: readonly ComparisonClaim[], aliases?: ComparisonAliases): ComparisonGroup[] {
  const rows: ComparableRow[] = [];
  for (const claim of claims) { const row = toComparable(claim, aliases); if (row) rows.push(row); }
  const byKey = new Map<string, ComparableRow[]>();
  for (const row of rows) {
    const key = [row.taskKey, row.metricKey, row.datasetKey, row.unit, row.conditionsKey].join(' | ');
    const group = byKey.get(key);
    if (group) group.push(row); else byKey.set(key, [row]);
  }
  const groups: ComparisonGroup[] = [];
  const keys = [...byKey.keys()].sort();
  for (const key of keys) {
    const bucket = byKey.get(key) ?? [];
    if (bucket.length < 2) continue;
    if (!distinctSources(bucket)) continue;
    if (sameSourceDuplicate(bucket)) continue;
    const first = bucket[0];
    if (!first) continue;
    const values = bucket.map((row) => row.value);
    const disagreement = Math.min(...values) !== Math.max(...values);
    const sorted = [...bucket].sort((a, b) => (a.claim.sourceId < b.claim.sourceId ? -1 : a.claim.sourceId > b.claim.sourceId ? 1 : a.claim.block - b.claim.block));
    groups.push({ id: 'cmp:' + key, task: first.claim.task ?? '', metric: first.claim.metric ?? '', dataset: first.claim.dataset ?? '', unit: first.claim.unit ?? '', conditions: first.claim.conditions ?? '', rows: sorted.map((row) => row.claim), disagreement: disagreement });
  }
  return groups;
}
