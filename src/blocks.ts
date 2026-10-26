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

interface Line { body: string; start: number; end: number; charStart: number; charEnd: number }
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
  let heading: string | null = null;
  let pending: { type: Block["type"]; first: Line; last: Line } | undefined;
  let fence: { char: string; count: number } | undefined;
  function emit(type: Block["type"], first: Line, last: Line) {
    const size = last.end - first.start;
    if (size <= (type === "paragraph" ? 1536 : MAX_BLOCK_BYTES)) {
      result.push({ id: result.length + 1, type, start: first.start, end: last.end, heading });
      return;
    }
    const bytes = encoder.encode(text.slice(first.charStart, last.charEnd));
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
      result.push({ id: result.length + 1, type, start: first.start + offset, end: first.start + stop, heading });
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
  return result;
}
