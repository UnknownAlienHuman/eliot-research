import type { Block } from "./blocks.js";
import { numbersSupported } from "./numbers.ts";

/**
 * K2 label/citation resolver (IMPLEMENTATION 5, 8; root contract 2026-10-26).
 * Model answer text is untrusted: only exact compact `[S<alias>:<block>]`
 * and persistent `[R<full-revision-uuid>:<block>]` labels outside fenced and inline
 * code resolve against the frozen source scope. Unknown, out-of-scope,
 * malformed, ambiguous, out-of-range and bare [S<N>] labels are removed and counted.
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
const LABEL_RE = /\[(?:S\d+:[^\]\n[]*|R[^:\]\n[]*:[^\]\n[]*|S\d+)\]/g;
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
  const inline = inlineCodeRanges(answer, fences);
  const code = [...fences, ...inline].sort((a, b) => a.start - b.start);
  const inside = (at: number): boolean => code.some((range) => at >= range.start && at < range.end);
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
 * to persistent form, using the existing fence- and inline-code-aware scanner.
 * Labels inside fenced or inline code and any other bytes are preserved untouched. Each returned
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
  const inline = inlineCodeRanges(text, fences);
  const code = [...fences, ...inline].sort((a, b) => a.start - b.start);
  const inside = (at: number): boolean => code.some((range) => at >= range.start && at < range.end);
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

interface TextRange {
  start: number;
  end: number;
}

interface StatementBlock extends TextRange {
  kind: "prose" | "heading" | "list" | "table";
}

const answerSentenceSegmenter = new Intl.Segmenter(["en", "ru"], { granularity: "sentence" });
const sectionHeadings = new Set([
  "answer", "background", "conclusion", "conclusions", "discussion", "evidence", "inference", "key points",
  "methods", "method", "overview", "results", "sources", "summary", "takeaways",
  "\u043e\u0431\u0437\u043e\u0440", "\u043e\u0442\u0432\u0435\u0442", "\u0432\u044b\u0432\u043e\u0434", "\u0432\u044b\u0432\u043e\u0434\u044b",
  "\u043a\u0440\u0430\u0442\u043a\u043e", "\u043c\u0435\u0442\u043e\u0434\u044b", "\u043e\u0431\u0441\u0443\u0436\u0434\u0435\u043d\u0438\u0435",
  "\u043e\u0441\u043d\u043e\u0432\u043d\u043e\u0435", "\u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442\u044b", "\u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0438",
]);

function inlineCodeRanges(text: string, fences: TextRange[]): TextRange[] {
  const ranges: TextRange[] = [];
  let i = 0;
  while (i < text.length) {
    const fence = fences.find((range) => i >= range.start && i < range.end);
    if (fence !== undefined) {
      i = fence.end;
      continue;
    }
    if (text[i] !== "`") {
      i += 1;
      continue;
    }

    let openLength = 1;
    while (text[i + openLength] === "`") openLength += 1;
    let j = i + openLength;
    let closeStart = -1;
    while (j < text.length) {
      const containingFence = fences.find((range) => j >= range.start && j < range.end);
      if (containingFence !== undefined) {
        j = containingFence.end;
        continue;
      }
      if (text[j] !== "`") {
        j += 1;
        continue;
      }
      let closeLength = 1;
      while (text[j + closeLength] === "`") closeLength += 1;
      if (closeLength === openLength) {
        closeStart = j;
        break;
      }
      j += closeLength;
    }

    if (closeStart < 0) {
      i += openLength;
      continue;
    }
    const end = closeStart + openLength;
    ranges.push({ start: i, end });
    i = end;
  }
  return ranges;
}

function maskRanges(text: string, ranges: TextRange[]): string {
  if (ranges.length === 0) return text;
  const chars = text.split("");
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i += 1) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  }
  return chars.join("");
}

function cleanStatement(text: string): string {
  return text
    .replace(LABEL_RE, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, " ")
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/gm, " ")
    .replace(/^\s{0,3}>\s?/gm, " ")
    .replace(/[|*_~`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasStatementSignal(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text) || /[=<>+*/×÷^∑∫√]/u.test(text);
}

function isExplicitInferenceOrAbstention(text: string): boolean {
  const start = text.replace(/^[\s"'“‘(]+/u, "");
  const inference = /^(?:my\s+inference|inference|interpretation)(?::[ \t]*|[ \t]*[—–][ \t]*)(?=\S)/iu.test(start)
    || /^\[inference\](?::[ \t]*|[ \t]+|[—–][ \t]*)(?=\S)/iu.test(start)
    || /^this is (?:an? )?inference\b/iu.test(start)
    || /^(?:i|we) infer\b/iu.test(start)
    || /^вывод(?:\s+\[inference\])?(?::[ \t]*|[—–][ \t]*)(?=\S)|^(?:предположение|это предположение|моё предположение|мое предположение)(?::[ \t]*|[—–][ \t]*)(?=\S)/iu.test(start)
    || /^(?:я предполагаю|можно предположить)(?:[ \t]*[,—:]|[ \t]+)(?=\S)/iu.test(start)
    || /^интерпретация(?::[ \t]*|[ \t]*[—–][ \t]*)(?=\S)/iu.test(start)
    || /^полагаю,\s*что(?=$|[^\p{L}\p{N}_-])/iu.test(start);
  const abstention = /^(?:i|we) abstain\b|^(?:i|we) (?:cannot|can't|could not|couldn't|do not|don't) (?:determine|say|tell|identify|answer|conclude|verify|establish|find|see|confirm|know)\b/iu.test(start)
    || /^(?:the\s+)?(?:source|sources|evidence|provided sources?)\s+(?:do not|don't|does not|doesn't)\s+(?:state|say|specify|report|provide|contain)|^no\s+(?:source|evidence)\s+(?:says?|states?|shows?|was provided)|^there is not enough (?:evidence|information)|^insufficient (?:evidence|information)/iu.test(start)
    || /^(?:не могу|невозможно|нельзя)\s+(?:определить|установить|сказать|ответить|проверить|заключить)|^(?:в источниках|источники|предоставленные источники)\s+(?:не указано|не сообщают|не содержат|не позволяют определить)|^недостаточно\s+(?:данных|сведений|информации)|^воздерживаюсь\s*:\s*\S/iu.test(start);
  const russianMissingAnswer = /^я не нахожу в (?:этой\s+)?статье\s+ответа(?=$|[^\p{L}\p{N}_-])/iu.test(start);
  return inference || abstention || russianMissingAnswer;
}

function isTableDelimiter(line: string): boolean {
  return /^ {0,3}\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function hasUnescapedPipe(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "|") continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) slashes += 1;
    if (slashes % 2 === 0) return true;
  }
  return false;
}

function blockKind(line: string): StatementBlock["kind"] | undefined {
  if (/^ {0,3}#{1,6}(?:\s+|$)/.test(line)) return "heading";
  if (/^ {0,3}(?:[-+*]|\d+[.)])\s+/.test(line)) return "list";
  return undefined;
}

function statementBlocks(text: string, analyzed: string, fences: TextRange[]): StatementBlock[] {
  const blocks: StatementBlock[] = [];
  let current: StatementBlock | undefined;
  let inTable = false;
  const flush = (): void => {
    if (current !== undefined) blocks.push(current);
    current = undefined;
  };

  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineStart = offset;
    const lineEnd = lineStart + line.length + (i < lines.length - 1 ? 1 : 0);
    offset = lineEnd;
    if (fences.some((range) => lineStart < range.end && lineEnd > range.start)) {
      flush();
      inTable = false;
      continue;
    }

    const markdownLine = line.replace(/\r$/, "");
    if (!inTable && hasUnescapedPipe(markdownLine) && isTableDelimiter(lines[i + 1] ?? "")) {
      flush();
      inTable = true;
      continue;
    }
    if (inTable) {
      if (markdownLine.trim() === "" || !hasUnescapedPipe(markdownLine)) {
        inTable = false;
      } else if (isTableDelimiter(markdownLine)) {
        flush();
        continue;
      } else {
        flush();
        blocks.push({ start: lineStart, end: lineEnd, kind: "table" });
        continue;
      }
    }

    const visible = cleanStatement(analyzed.slice(lineStart, lineStart + line.length));
    if (visible === "") {
      if (/\[(?:S\d+|R)[^\]\n]*\]/.test(line)) {
        if (current !== undefined) current.end = lineEnd;
        else if (blocks.length > 0) (blocks[blocks.length - 1] as StatementBlock).end = lineEnd;
      } else {
        flush();
      }
      continue;
    }

    const kind = blockKind(line.replace(/\r$/, ""));
    if (kind !== undefined) {
      flush();
      blocks.push({ start: lineStart, end: lineEnd, kind });
    } else if (current === undefined) {
      current = { start: lineStart, end: lineEnd, kind: "prose" };
    } else {
      current.end = lineEnd;
    }
  }
  flush();
  return blocks;
}

function sentenceRanges(block: StatementBlock, analyzed: string): TextRange[] {
  let sentences: TextRange[];
  if (block.kind === "table") {
    sentences = [{ start: block.start, end: block.end }];
  } else {
    const text = analyzed.slice(block.start, block.end);
    const labels = [...text.matchAll(LABEL_RE)];
    // ICU may split "fact.[S1:1]" after the opening bracket. A citation
    // token must remain atomic without changing the answer or its offsets.
    const boundary = (at: number): number => labels.find((label) =>
      at > label.index && at < label.index + label[0].length)?.index ?? at;
    const segments = [...answerSentenceSegmenter.segment(text)];
    sentences = [];
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (segment === undefined) continue;
      let start = block.start + boundary(segment.index);
      const end = block.start + boundary(segments[i + 1]?.index ?? text.length);
      if (end <= start) continue;
      const segmentText = analyzed.slice(start, end);
      // Segmenter can put a postfix label after sentence punctuation into the
      // next segment. Give leading label tokens back to the preceding sentence
      // so they cannot cover its uncited neighbor. Only range boundaries move;
      // answer text and persisted citation byte offsets remain unchanged.
      const previous = sentences[sentences.length - 1];
      if (previous !== undefined && previous.start >= block.start) {
        let prefixEnd = 0;
        for (const label of segmentText.matchAll(LABEL_RE)) {
          if (segmentText.slice(prefixEnd, label.index).trim() !== "") break;
          prefixEnd = label.index + label[0].length;
        }
        if (prefixEnd > 0) {
          start += prefixEnd;
          previous.end = start;
        }
      }
      if (!hasStatementSignal(cleanStatement(analyzed.slice(start, end)))) {
        if (previous !== undefined) previous.end = end;
        continue;
      }
      sentences.push({ start, end });
    }
  }

  return sentences;
}

interface FactualStatement {
  text: string;
  labels: string[];
}

/** The same factual units and exact local labels back both completion gates. */
function factualStatements(text: string, citations: Citation[]): FactualStatement[] {
  const fences = fencedRanges(text);
  const inline = inlineCodeRanges(text, fences);
  const code = [...fences, ...inline].sort((a, b) => a.start - b.start);
  const analyzed = maskRanges(text, fences);
  const knownLabels = new Set(citations.map((citation) => citation.label));
  const resolved: (TextRange & { label: string })[] = [];
  for (const match of text.matchAll(LABEL_RE)) {
    const start = match.index ?? -1;
    if (start < 0 || !knownLabels.has(match[0]) || code.some((range) => start >= range.start && start < range.end)) continue;
    resolved.push({ start, end: start + match[0].length, label: match[0] });
  }

  const units: FactualStatement[] = [];
  for (const block of statementBlocks(text, analyzed, fences)) {
    for (const statement of sentenceRanges(block, analyzed)) {
      const content = cleanStatement(analyzed.slice(statement.start, statement.end));
      if (!hasStatementSignal(content)) continue;
      const heading = content.toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
      if (block.kind === "heading" && sectionHeadings.has(heading)) continue;
      if (isExplicitInferenceOrAbstention(content)) continue;
      const labels = [...new Set(resolved
        .filter((range) => range.start >= statement.start && range.end <= statement.end)
        .map((range) => range.label))];
      units.push({ text: content, labels });
    }
  }
  return units;
}

/** Citation presence/locality only; this does not establish semantic entailment. */
export function uncitedStatements(text: string, citations: Citation[]): number {
  return factualStatements(text, citations).filter((unit) => unit.labels.length === 0).length;
}

/** Exact resolved labels whose local factual unit needs numeric evidence. */
export function numericCitationLabels(text: string, citations: Citation[]): string[] {
  return [...new Set(factualStatements(text, citations)
    .filter((unit) => !numbersSupported(unit.text, ""))
    .flatMap((unit) => unit.labels))];
}

/**
 * Count numeric factual units unsupported by their own adjacent selected quotes.
 * Citation tokens/Markdown syntax were removed by factualStatements; fences,
 * structural headings and explicit inference/abstention follow the coverage gate.
 * Missing quotes provide no evidence. No unrelated answer-wide quote union,
 * label reassignment, numeric repair or semantic-entailment claim is made.
 */
export function unsupportedNumericStatements(
  text: string,
  citations: Citation[],
  quotes: ReadonlyMap<string, string>,
): number {
  return factualStatements(text, citations).filter((unit) => {
    if (numbersSupported(unit.text, "")) return false;
    const selected = unit.labels.map((label) => quotes.get(label) ?? "").join("\n");
    return !numbersSupported(unit.text, selected);
  }).length;
}
