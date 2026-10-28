import { numbersSupported, parseSingleNumber } from "./numbers.js";
import { sliceUtf8 } from "./blocks.js";
import type { Block } from "./blocks.js";

/**
 * K3 exact-quote verifier (IMPLEMENTATION 5/6).
 * verifyClaims: byte-exact search in the stated block, then adjacent blocks,
 * then a conservative whitespace/quote/dash/soft-hyphen fold mapped to
 * original bytes. Drops empty/unknown/unmatched and number-unsupported
 * statements (shared numbersSupported digit-group plus decimal-token rule).
 * Stored quote is the canonical slice; ambiguous duplicates are kept.
 * resolveQuoteBlock maps one [S1:N] label; cleanDistillText strips only
 * declared reference tokens; splitDistillStatements keeps fenced code as one
 * unit. resultStatement formats one scalar result card and rejects it when
 * the composed task/dataset/conditions plus metric:valueText+unit lacks numeric
 * support. verifyClaims leaves task/metric/dataset unchecked by itself.
 */

export interface CandidateClaim {
  kind: "method" | "result" | "limitation" | "dataset" | "definition" | "other";
  statement: string;
  quote: string;
  block: number;
  task: string | null;
  metric: string | null;
  dataset: string | null;
  valueText: string | null;
  unit: string | null;
  conditions: string | null;
}

export interface VerifiedClaim extends CandidateClaim {
  start: number;
  end: number;
  ambiguous: boolean;
  valueNumber: number | null;
}

const COMPACT_LABEL_RE = /^\[S(\d+):(\d+)\]$/;
const REF_CANDIDATE_RE = /\[(?:S\d+[^\]\n[]*|R[^:\]\n[]*:[^\]\n[]*|block\s+[^\]\n[]*)\]/g;
const SINGLES = new Set(["\u2018", "\u2019", "\u201A", "\u2039", "\u203A"]);
const DOUBLES = new Set(["\u201C", "\u201D", "\u201E", "\u201F", "\u00AB", "\u00BB"]);
const DASHES = new Set(["\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2212"]);
const SOFT_HYPHEN = "\u00AD";

const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter(["en", "ru"], { granularity: "sentence" });

interface Fence {
  char: string;
  count: number;
}

interface Slice {
  base: number;
  text: string;
  folded: string;
  map: number[];
}

interface Hit {
  blockId: number;
  start: number;
  end: number;
}

/**
 * Map one exact S1 compact label to its canonical block slice. The K3 job
 * freezes a single source, so any other alias is out of scope. Rejects
 * persistent labels, malformed or out-of-scope ids and unreadable or empty
 * byte ranges. No search, no fallback, no generation.
 */
export function resolveQuoteBlock(
  text: string,
  blocks: readonly Block[],
  label: string,
): { block: number; quote: string } | undefined {
  if (typeof text !== "string" || typeof label !== "string") return undefined;
  const match = COMPACT_LABEL_RE.exec(label);
  const alias = match?.[1];
  const blockId = match?.[2];
  if (alias === undefined || blockId === undefined) return undefined;
  if (Number(alias) !== 1) return undefined;
  const block = Number(blockId);
  if (!Number.isSafeInteger(block) || block < 1) return undefined;
  const row = blocks.find((entry) => entry.id === block);
  if (row === undefined) return undefined;
  let quote: string;
  try {
    quote = sliceUtf8(text, row.start, row.end);
  } catch {
    return undefined;
  }
  if (quote === "") return undefined;
  return { block, quote };
}

/** Char ranges covered by ```/~~~ fenced code; labels inside never resolve. */
function fencedRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const parts = text.split("\n");
  let fence: Fence | undefined;
  let fenceStart = 0;
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i] ?? "";
    const lineEnd = pos + line.length + (i < parts.length - 1 ? 1 : 0);
    if (fence === undefined) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (open !== undefined) {
        fence = { char: open[0] ?? "`", count: open.length };
        fenceStart = pos;
      }
    } else {
      const trimmed = line.trim();
      if (trimmed.startsWith(fence.char.repeat(fence.count)) && new RegExp(`^${fence.char}+$`).test(trimmed)) {
        ranges.push({ start: fenceStart, end: lineEnd });
        fence = undefined;
      }
    }
    pos = lineEnd;
  }
  if (fence !== undefined) ranges.push({ start: fenceStart, end: text.length });
  return ranges;
}

/** Inline `code` spans; an unclosed backtick run stays literal prose. */
function inlineCodeRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let open = 0;
    while (text[i + open] === "`") open++;
    let j = i + open;
    let found = -1;
    while (j < text.length) {
      if (text[j] !== "`") {
        j += 1;
        continue;
      }
      let close = 0;
      while (text[j + close] === "`") close++;
      if (close === open) {
        found = j;
        break;
      }
      j += close;
    }
    if (found < 0) break;
    ranges.push({ start: i, end: found + open });
    i = found + open;
  }
  return ranges;
}

/**
 * Strip only authority-declared reference tokens from model prose outside
 * fenced and inline code: exact declared labels, own persistent forms for
 * their blocks and `[block N]` for the same blocks. Anything else
 * label-shaped is left in place and counted, so the caller can drop the item
 * instead of silently erasing unknown references. Genuine brackets,
 * numbers and code pass through untouched. When preserveReferences is true
 * the same recognized tokens are rewritten to `[Rrevision:block]` instead
 * of deleted, so prose like "in block [S1:37]" keeps its anchor; the
 * default false keeps the validation strip for the numeric guard.
 */
export function cleanDistillText(
  text: string,
  labels: readonly string[],
  revisionId: string,
  preserveReferences = false,
): { text: string; invalidReferences: number } {
  if (typeof text !== "string") return { text: "", invalidReferences: 0 };
  const known = new Map<string, number>();
  if (Array.isArray(labels) && typeof revisionId === "string") {
    for (const label of labels) {
      if (typeof label !== "string") continue;
      const match = COMPACT_LABEL_RE.exec(label);
      const blockId = match?.[2];
      if (match === null || blockId === undefined) continue;
      const block = Number(blockId);
      if (!Number.isSafeInteger(block) || block < 1) continue;
      known.set(label, block);
      known.set(`[R${revisionId}:${block}]`, block);
      known.set(`[block ${block}]`, block);
    }
  }
  const fences = [...fencedRanges(text), ...inlineCodeRanges(text)];
  const inside = (at: number): boolean => fences.some((range) => at >= range.start && at < range.end);
  const parts: string[] = [];
  let last = 0;
  let invalidReferences = 0;
  for (const candidate of text.matchAll(REF_CANDIDATE_RE)) {
    const at = candidate.index ?? -1;
    if (at < 0 || inside(at)) continue;
    const token = candidate[0];
    const block = known.get(token);
    if (block !== undefined) {
      if (preserveReferences === true && typeof revisionId === "string") {
        parts.push(text.slice(last, at) + `[R${revisionId}:${block}]`);
      } else {
        parts.push(text.slice(last, at));
      }
      last = at + token.length;
    } else {
      invalidReferences += 1;
    }
  }
  parts.push(text.slice(last));
  return { text: parts.join(""), invalidReferences };
}

/**
 * Cut model prose into sentences for per-sentence guard validation.
 * Standard UAX #29 sentence segmentation keeps decimals and exponents
 * intact. Fenced code blocks pass through as single exact units. Prose gaps
 * are trimmed and empty units are dropped. Nothing is rewritten.
 */
export function splitDistillStatements(text: string): string[] {
  if (typeof text !== "string") return [];
  const fences = [...fencedRanges(text)].sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let last = 0;
  const flush = (gap: string): void => {
    for (const part of segmenter.segment(gap)) {
      const sentence = part.segment.trim();
      if (sentence !== "") out.push(sentence);
    }
  };
  for (const range of fences) {
    if (range.start > last) flush(text.slice(last, range.start));
    if (range.start >= last) out.push(text.slice(range.start, range.end));
    last = Math.max(last, range.end);
  }
  if (last < text.length) flush(text.slice(last));
  return out;
}

/** Fold one slice; map[folded index] is the UTF-16 index of the source unit. */
function foldText(input: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let i = 0;
  while (i < input.length) {
    const unit = input[i];
    if (unit === undefined) break;
    if (unit === SOFT_HYPHEN) {
      i += 1;
      continue;
    }
    if (/\s/u.test(unit)) {
      let j = i + 1;
      while (j < input.length && /\s/u.test(input[j] as string)) j++;
      folded += " ";
      map.push(i);
      i = j;
      continue;
    }
    const foldedChar = SINGLES.has(unit) ? "'" : DOUBLES.has(unit) ? '"' : DASHES.has(unit) ? "-" : undefined;
    if (foldedChar === undefined) {
      const width = (input.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
      folded += input.slice(i, i + width);
      map.push(i);
      i += width;
    } else {
      folded += foldedChar;
      map.push(i);
      i += 1;
    }
  }
  return { folded, map };
}

function byteOffset(base: number, slice: string, utf16Index: number): number {
  return base + encoder.encode(slice.slice(0, utf16Index)).byteLength;
}

function loadSlices(text: string, blocks: readonly Block[]): Map<number, Slice> {
  const out = new Map<number, Slice>();
  for (const block of blocks) {
    if (!Number.isInteger(block.id) || block.id < 1) continue;
    let slice: string;
    try {
      slice = sliceUtf8(text, block.start, block.end);
    } catch {
      continue;
    }
    const folded = foldText(slice);
    out.set(block.id, { base: block.start, text: slice, folded: folded.folded, map: folded.map });
  }
  return out;
}

function scopeOrder(slices: Map<number, Slice>, id: number): number[] {
  const order = [id];
  if (slices.has(id - 1)) order.push(id - 1);
  if (slices.has(id + 1)) order.push(id + 1);
  return order;
}

function exactHits(slices: Map<number, Slice>, order: number[], quote: string): Hit[] {
  const hits: Hit[] = [];
  for (const id of order) {
    const slice = slices.get(id);
    if (slice === undefined) continue;
    let from = 0;
    while (hits.length < 2) {
      const at = slice.text.indexOf(quote, from);
      if (at < 0) break;
      hits.push({ blockId: id, start: byteOffset(slice.base, slice.text, at), end: byteOffset(slice.base, slice.text, at + quote.length) });
      from = at + 1;
    }
    if (hits.length >= 2) break;
  }
  return hits;
}

function foldedHits(slices: Map<number, Slice>, order: number[], foldedQuote: string): Hit[] {
  const hits: Hit[] = [];
  for (const id of order) {
    const slice = slices.get(id);
    if (slice === undefined) continue;
    let from = 0;
    while (hits.length < 2) {
      const at = slice.folded.indexOf(foldedQuote, from);
      if (at < 0) break;
      const start16 = slice.map[at];
      const end16 = at + foldedQuote.length < slice.folded.length ? slice.map[at + foldedQuote.length] : slice.text.length;
      if (start16 === undefined || end16 === undefined) break;
      hits.push({ blockId: id, start: byteOffset(slice.base, slice.text, start16), end: byteOffset(slice.base, slice.text, end16) });
      from = at + 1;
    }
    if (hits.length >= 2) break;
  }
  return hits;
}

/** Parse one plain/decimal/thousands/scientific value; percent kept as written. */


export function verifyClaims(
  text: string,
  blocks: readonly Block[],
  candidates: readonly CandidateClaim[],
): { claims: VerifiedClaim[]; dropped: { index: number; reason: string }[]; clearedNumbers: number } {
  const slices = loadSlices(text, blocks);
  const claims: VerifiedClaim[] = [];
  const dropped: { index: number; reason: string }[] = [];
  let clearedNumbers = 0;
  candidates.forEach((candidate, index) => {
    if (typeof candidate.quote !== "string" || candidate.quote.replace(/[\s\u00AD]/gu, "") === "") {
      dropped.push({ index, reason: "empty-quote" });
      return;
    }
    if (!Number.isInteger(candidate.block) || candidate.block < 1 || !slices.has(candidate.block)) {
      dropped.push({ index, reason: "unknown-block" });
      return;
    }
    const order = scopeOrder(slices, candidate.block);
    let hits = exactHits(slices, order, candidate.quote);
    if (hits.length === 0) {
      const foldedQuote = foldText(candidate.quote).folded;
      hits = foldedQuote === "" ? [] : foldedHits(slices, order, foldedQuote);
    }
    const first = hits[0];
    if (first === undefined) {
      dropped.push({ index, reason: "unmatched" });
      return;
    }
    const verifiedText = sliceUtf8(text, first.start, first.end);
    if (!numbersSupported(candidate.statement, verifiedText)) {
      dropped.push({ index, reason: "unsupported-statement-numbers" });
      return;
    }
    if (candidate.conditions !== null && candidate.conditions !== undefined && !numbersSupported(candidate.conditions, verifiedText)) {
      dropped.push({ index, reason: "unsupported-condition-numbers" });
      return;
    }
    let valueText = candidate.valueText;
    let unit = candidate.unit;
    let valueNumber: number | null = null;
    if (valueText !== null && valueText !== undefined) {
      if (!numbersSupported(valueText, verifiedText)) {
        valueText = null;
        unit = null;
        clearedNumbers += 1;
      } else {
        valueNumber = parseSingleNumber(valueText);
      }
    }
    claims.push({
      kind: candidate.kind,
      statement: candidate.statement,
      quote: verifiedText,
      block: first.blockId,
      task: candidate.task,
      metric: candidate.metric,
      dataset: candidate.dataset,
      valueText,
      unit,
      conditions: candidate.conditions,
      start: first.start,
      end: first.end,
      ambiguous: hits.length > 1,
      valueNumber,
    });
  });
  return { claims, dropped, clearedNumbers };
}

/**
 * Format one stored result card after the normal verify step. Non-result
 * claims keep their original statement. A result claim must carry its
 * single parsed scalar (valueText plus a finite valueNumber); the card
 * keeps only that primary record built from the raw task/dataset/
 * conditions plus metric:valueText+unit, joining (never doubling) the
 * unit. The composed record must itself be supported by the same verified
 * quote, otherwise the card is rejected with null. Callers run
 * verifyClaims first; this formats, it does not re-admit.
 */
export function resultStatement(claim: VerifiedClaim): string | null {
  if (claim.kind !== "result") return claim.statement;
  if (typeof claim.valueText !== "string" || claim.valueText.trim() === "") return null;
  if (
    claim.valueNumber !== null &&
    claim.valueNumber !== undefined &&
    (typeof claim.valueNumber !== "number" || !Number.isFinite(claim.valueNumber))
  )
    return null;
  const clean = (value: string | null): string | null =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  const text = claim.valueText.trim();
  const unit = clean(claim.unit);
  const scalar =
    unit === null || text.endsWith(unit) ? text : unit === "%" ? text + unit : text + " " + unit;
  const metric = clean(claim.metric);
  const record = metric === null ? scalar : metric + " " + scalar;
  const context = [clean(claim.task), clean(claim.dataset), clean(claim.conditions)].filter(
    (part): part is string => part !== null,
  );
  const composed = context.length > 0 ? context.join(", ") + ": " + record : record;
  if (!numbersSupported(composed, claim.quote)) return null;
  return composed;
}
