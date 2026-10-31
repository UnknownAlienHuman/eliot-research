export interface Block {
  id: number;
  type: "heading" | "paragraph" | "list" | "table" | "code" | "quote";
  start: number;
  end: number;
  heading: string | null;
}
export const MAX_BLOCK_BYTES = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const continuation = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;

export function sliceUtf8(text: string, start: number, end: number): string {
  const bytes = encoder.encode(text);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > bytes.length
    || continuation(bytes[start]) || continuation(bytes[end])) throw new RangeError("Invalid UTF-8 byte range.");
  return decoder.decode(bytes.subarray(start, end));
}

export function isCitableBlock(block: Block, passage: string): boolean {
  const trimmed = passage.trim().replace(/^\uFEFF/u, "").trim();
  if (!trimmed) return false;
  const content = block.type === "code" ? trimmed : trimmed
    .replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/u, "")
    .replace(/[ \t]+#{1,6}[ \t]*$/u, "")
    .trim();
  if (!content) return false;
  return !/^(?:page|страница)\s+\d+$/iu.test(content);
}

interface Line { body: string; start: number; end: number; charStart: number; charEnd: number }
interface CharacterRange { start: number; end: number }
interface TableCaptionCandidate { captionIndex: number; tableIndex: number }

const tableCaptionStart = /^ {0,3}Table[ \t]+\d+[A-Za-z]?[.:][ \t]+\S/iu;

function isWholeTableBlock(blocks: Block[], index: number): boolean {
  const block = blocks[index];
  if (block?.type !== "table") return false;
  const previous = blocks[index - 1], next = blocks[index + 1];
  return !(previous?.type === "table" && previous.end === block.start)
    && !(next?.type === "table" && block.end === next.start);
}

function isWholeParagraphBlock(blocks: Block[], index: number): boolean {
  const block = blocks[index];
  if (block?.type !== "paragraph") return false;
  const previous = blocks[index - 1], next = blocks[index + 1];
  return !(previous?.type === "paragraph" && previous.end === block.start)
    && !(next?.type === "paragraph" && block.end === next.start);
}

function onlyWhitespace(text: string, start: number, end: number): boolean {
  return end >= start && /^\s*$/u.test(text.slice(start, end));
}

function joinAdjacentTableCaptions(text: string, blocks: Block[], characterRanges: CharacterRange[]): Block[] {
  const candidates: TableCaptionCandidate[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index], range = characterRanges[index];
    if (block?.type !== "paragraph" || range === undefined) continue;
    const firstLine = text.slice(range.start, range.end).split(/\r\n|\r|\n/u, 1)[0] ?? "";
    if (!tableCaptionStart.test(firstLine)) continue;

    const previous = blocks[index - 1], previousRange = characterRanges[index - 1];
    const next = blocks[index + 1], nextRange = characterRanges[index + 1];
    const hasPreviousTable = previous?.type === "table" && previousRange !== undefined
      && onlyWhitespace(text, previousRange.end, range.start);
    const hasNextTable = next?.type === "table" && nextRange !== undefined
      && onlyWhitespace(text, range.end, nextRange.start);

    // A caption between two tables, or one without a neighboring table, has no safe association.
    if (hasPreviousTable === hasNextTable) continue;
    const tableIndex = hasPreviousTable ? index - 1 : index + 1;
    if (!isWholeTableBlock(blocks, tableIndex) || !isWholeParagraphBlock(blocks, index)) continue;
    candidates.push({ captionIndex: index, tableIndex });
  }

  const captionsByTable = new Map<number, number[]>();
  for (const candidate of candidates) {
    const captions = captionsByTable.get(candidate.tableIndex) ?? [];
    captions.push(candidate.captionIndex);
    captionsByTable.set(candidate.tableIndex, captions);
  }

  const rangesByTable = new Map<number, { start: number; end: number }>();
  const joinedCaptions = new Set<number>();
  for (const [tableIndex, captionIndexes] of captionsByTable) {
    if (captionIndexes.length !== 1) continue;
    const captionIndex = captionIndexes[0];
    if (captionIndex === undefined) continue;
    const table = blocks[tableIndex], caption = blocks[captionIndex];
    if (table?.type !== "table" || caption?.type !== "paragraph") continue;
    const start = Math.min(table.start, caption.start), end = Math.max(table.end, caption.end);
    if (end - start > MAX_BLOCK_BYTES) continue;
    rangesByTable.set(tableIndex, { start, end });
    joinedCaptions.add(captionIndex);
  }

  if (joinedCaptions.size === 0) return blocks;
  const result: Block[] = [];
  for (const [index, block] of blocks.entries()) {
    if (joinedCaptions.has(index)) continue;
    const range = rangesByTable.get(index);
    result.push({ ...block, id: result.length + 1, ...(range ?? {}) });
  }
  return result;
}

function* lines(text: string): Generator<Line> {
  let charStart = 0, start = 0;
  while (charStart < text.length) {
    const lf = text.indexOf("\n", charStart), cr = text.indexOf("\r", charStart);
    const newline = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
    const charEnd = newline < 0 ? text.length : newline + (text[newline] === "\r" && text[newline + 1] === "\n" ? 2 : 1);
    const raw = text.slice(charStart, charEnd);
    const end = start + encoder.encode(raw).byteLength;
    yield { body: raw.replace(/(?:\r\n|\r|\n)$/, ""), start, end, charStart, charEnd };
    start = end; charStart = charEnd;
  }
}

export function scanBlocks(text: string): Block[] {
  const result: Block[] = [];
  const characterRanges: CharacterRange[] = [];
  let heading: string | null = null;
  let pending: { type: Block["type"]; first: Line; last: Line } | undefined;
  let fence: { char: string; count: number } | undefined;
  function emit(type: Block["type"], first: Line, last: Line) {
    const size = last.end - first.start;
    if (size <= (type === "paragraph" ? 1536 : MAX_BLOCK_BYTES)) {
      result.push({ id: result.length + 1, type, start: first.start, end: last.end, heading });
      characterRanges.push({ start: first.charStart, end: last.charEnd });
      return;
    }
    const bytes = encoder.encode(text.slice(first.charStart, last.charEnd));
    let characterOffset = 0;
    for (let offset = 0; offset < bytes.length;) {
      let stop = Math.min(bytes.length, offset + (type === "paragraph" ? 1024 : MAX_BLOCK_BYTES));
      while (continuation(bytes[stop])) stop--;
      if (stop < bytes.length && type === "paragraph") {
        const candidate = decoder.decode(bytes.subarray(offset, stop));
        let sentenceEnd = 0;
        for (const match of candidate.matchAll(/[.!?…]["'”’»\])]*\s+/gu)) sentenceEnd = (match.index ?? 0) + match[0].length;
        if (sentenceEnd > candidate.length / 2) stop = offset + encoder.encode(candidate.slice(0, sentenceEnd)).byteLength;
        else {
          for (let point = stop - 1; point > offset + 512; point--) {
            if (bytes[point] === 32 || bytes[point] === 10) { stop = point + 1; break; }
          }
        }
      } else if (stop < bytes.length) {
        for (let point = stop - 1; point > offset; point--) {
          if (bytes[point] === 10) { stop = point + 1; break; }
        }
      }
      const chunkText = decoder.decode(bytes.subarray(offset, stop));
      result.push({ id: result.length + 1, type, start: first.start + offset, end: first.start + stop, heading });
      characterRanges.push({ start: first.charStart + characterOffset, end: first.charStart + characterOffset + chunkText.length });
      characterOffset += chunkText.length;
      offset = stop;
    }
  }
  function flush() {
    if (pending) emit(pending.type, pending.first, pending.last);
    pending = undefined;
  }
  const iterator = lines(text);
  let current = iterator.next();
  while (!current.done) {
    const line = current.value;
    let next = iterator.next();
    if (fence) {
      if (pending) pending.last = line;
      const close = line.body.trim();
      if (close.startsWith(fence.char.repeat(fence.count)) && new RegExp(`^${fence.char}+$`).test(close)) {
        flush(); fence = undefined;
      }
      current = next; continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line.body);
    if (opening?.[1]) {
      flush(); fence = { char: opening[1][0] ?? "`", count: opening[1].length };
      pending = { type: "code", first: line, last: line };
      current = next; continue;
    }
    if (!line.body.trim()) { flush(); current = next; continue; }
    const atx = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line.body);
    const setext = !next.done && /^(?: {0,3}=+| {0,3}-+)\s*$/.test(next.value.body);
    if (atx || (setext && !/^\s*[-*+]>?\s/.test(line.body))) {
      flush(); heading = (atx?.[1] ?? line.body.trim()).slice(0, 500);
      emit("heading", line, setext && !atx && !next.done ? next.value : line);
      if (setext && !atx) next = iterator.next();
      current = next; continue;
    }
    const tableStart = !next.done && line.body.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next.value.body);
    const type: Block["type"] = /^ {0,3}>/.test(line.body) ? "quote"
      : /^\s*(?:[-*+]|\d+[.)])\s+/.test(line.body) || (pending?.type === "list" && /^(?: {2,}|\t)\S/.test(line.body)) ? "list"
      : tableStart || (pending?.type === "table" && line.body.includes("|")) || /^\s*\|/.test(line.body) || /\|\s*$/.test(line.body) ? "table" : "paragraph";
    if (pending?.type !== type) { flush(); pending = { type, first: line, last: line }; }
    else pending.last = line;
    current = next;
  }
  flush();
  return joinAdjacentTableCaptions(text, result, characterRanges);
}
