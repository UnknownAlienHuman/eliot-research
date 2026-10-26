import type { Block } from "./blocks.js";

/**
 * K2 label/citation resolver (IMPLEMENTATION 5, 8; root contract 2026-10-26).
 * Model answer text is untrusted: only exact compact `[S<alias>:<block>]`
 * and persistent `[R<full-revision-uuid>:<block>]` labels outside fenced
 * code resolve against the frozen source scope. Unknown, out-of-scope,
 * malformed, ambiguous and out-of-range labels are removed and counted.
 * Offsets come from the block map only; nothing is fabricated.
 * Each citation keeps its sourceId and the label token as emitted in the
 * returned text, so the reader matches c.label (or the persistent label
 * derived from revisionId/block) without storing block maps per turn.
 * Quote verification is K3 and lives elsewhere.
 */

export interface Citation {
  revisionId: string;
  sourceId: string;
  block: number;
  start: number;
  end: number;
  sourceTitle: string;
  deleted: boolean;
  label: string;
}

export interface LabelSource {
  sourceId: string;
  revisionId: string;
  title: string;
  blocks: Block[];
  alias: string;
}

export interface ResolvedAnswer {
  text: string;
  citations: Citation[];
  invalidLabels: number;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LABEL_RE = /\[(?:S\d+:[^\]\n[]*|R[^:\]\n[]*:[^\]\n[]*)\]/g;
const DIGITS_RE = /^\d+$/;

interface Fence {
  char: string;
  count: number;
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

interface ScopeMaps {
  aliasGroups: Map<string, number[]>;
  revisionGroups: Map<string, number[]>;
  blockMaps: Array<Map<number, Block>>;
}

function scopeMaps(sources: LabelSource[]): ScopeMaps {
  const aliasGroups = new Map<string, number[]>();
  const revisionGroups = new Map<string, number[]>();
  const blockMaps = sources.map((source, index) => {
    const byId = new Map<number, Block>();
    for (const block of source.blocks ?? []) byId.set(block.id, block);
    const alias = aliasGroups.get(source.alias) ?? [];
    alias.push(index);
    aliasGroups.set(source.alias, alias);
    const rev = revisionGroups.get(source.revisionId) ?? [];
    rev.push(index);
    revisionGroups.set(source.revisionId, rev);
    return byId;
  });
  return { aliasGroups, revisionGroups, blockMaps };
}

interface ParsedLabel {
  sourceIndex: number;
  block: number;
  start: number;
  end: number;
}

/** Exact-match only: alias/revision must identify one source and the block must exist. */
function parseToken(token: string, maps: ScopeMaps): ParsedLabel | undefined {
  const kind = token[1];
  const inner = token.slice(2, -1);
  const split = inner.lastIndexOf(":");
  if (split < 0) return undefined;
  const head = inner.slice(0, split);
  const tail = inner.slice(split + 1);
  if (!DIGITS_RE.test(tail)) return undefined;
  const block = Number(tail);
  if (!Number.isSafeInteger(block) || block < 1) return undefined;
  if (kind === "S") {
    if (!DIGITS_RE.test(head)) return undefined;
    const group = maps.aliasGroups.get(`S${head}`);
    if (group === undefined || group.length !== 1) return undefined;
    const sourceIndex = group[0] ?? -1;
    const row = sourceIndex < 0 ? undefined : maps.blockMaps[sourceIndex]?.get(block);
    if (row === undefined) return undefined;
    return { sourceIndex, block, start: row.start, end: row.end };
  }
  if (kind === "R") {
    if (!UUID_RE.test(head)) return undefined;
    const group = maps.revisionGroups.get(head);
    if (group === undefined || group.length !== 1) return undefined;
    const sourceIndex = group[0] ?? -1;
    const row = sourceIndex < 0 ? undefined : maps.blockMaps[sourceIndex]?.get(block);
    if (row === undefined) return undefined;
    return { sourceIndex, block, start: row.start, end: row.end };
  }
  return undefined;
}

function resolve(answer: string, sources: LabelSource[], rewriteCompact: boolean): ResolvedAnswer {
  const maps = scopeMaps(sources);
  const fences = fencedRanges(answer);
  const inside = (at: number): boolean => fences.some((range) => at >= range.start && at < range.end);
  const seen = new Set<string>();
  const citations: Citation[] = [];
  const parts: string[] = [];
  let last = 0;
  let invalidLabels = 0;
  for (const match of answer.matchAll(LABEL_RE)) {
    const at = match.index ?? -1;
    if (at < 0 || inside(at)) continue;
    const token = match[0];
    const parsed = parseToken(token, maps);
    const source = parsed === undefined ? undefined : sources[parsed.sourceIndex];
    if (parsed === undefined || source === undefined) {
      invalidLabels += 1;
      parts.push(answer.slice(last, at));
      last = at + token.length;
      continue;
    }
    const outToken = rewriteCompact && token[1] === "S" ? `[R${source.revisionId}:${parsed.block}]` : token;
    const key = `${source.revisionId}:${parsed.block}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({
        revisionId: source.revisionId,
        sourceId: source.sourceId,
        block: parsed.block,
        start: parsed.start,
        end: parsed.end,
        sourceTitle: source.title,
        deleted: false,
        label: outToken,
      });
    }
    parts.push(answer.slice(last, at));
    parts.push(outToken);
    last = at + token.length;
  }
  parts.push(answer.slice(last));
  return { text: parts.join(""), citations, invalidLabels };
}

export function resolveCitations(answer: string, sources: LabelSource[]): ResolvedAnswer {
  return resolve(answer, sources, false);
}

export function persistentAnswer(text: string, sources: LabelSource[]): ResolvedAnswer {
  return resolve(text, sources, true);
}

/**
 * Save path for getStoredTurn: rewrites only already server-resolved labels
 * to persistent form, using the existing fence-aware scanner. Labels inside
 * fenced code and any other bytes are preserved untouched. Each returned
 * citation keeps its identity with label set to the persistent token.
 */
export function persistentResolvedAnswer(text: string, citations: Citation[]): ResolvedAnswer {
  const persistent = new Map<string, string>();
  const resolved: Citation[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    const token = `[R${citation.revisionId}:${citation.block}]`;
    persistent.set(citation.label, token);
    if (!seen.has(token)) {
      seen.add(token);
      resolved.push({ ...citation, label: token });
    }
  }
  const fences = fencedRanges(text);
  const inside = (at: number): boolean => fences.some((range) => at >= range.start && at < range.end);
  const parts: string[] = [];
  let last = 0;
  for (const match of text.matchAll(LABEL_RE)) {
    const at = match.index ?? -1;
    if (at < 0 || inside(at)) continue;
    const replacement = persistent.get(match[0]);
    if (replacement === undefined) continue;
    parts.push(text.slice(last, at));
    parts.push(replacement);
    last = at + match[0].length;
  }
  parts.push(text.slice(last));
  return { text: parts.join(""), citations: resolved, invalidLabels: 0 };
}
