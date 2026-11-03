interface CodeRange { start: number; end: number }
interface FencedCodeRange extends CodeRange { contentStart: number; contentEnd: number; closed: boolean }

/** Ordered half-open UTF-16 ranges for the supported top-level code fences. */
export function fencedCodeRanges(text: string): FencedCodeRange[] {
  const ranges: FencedCodeRange[] = [];
  const parts = text.split("\n");
  let fence: { char: string; count: number } | undefined;
  let fenceStart = 0;
  let contentStart = 0;
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i] ?? "";
    const lineEnd = pos + line.length + (i < parts.length - 1 ? 1 : 0);
    if (fence === undefined) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (open !== undefined) {
        fence = { char: open[0] ?? "`", count: open.length };
        fenceStart = pos;
        contentStart = lineEnd;
      }
    } else {
      const trimmed = line.trim();
      if (trimmed.startsWith(fence.char.repeat(fence.count)) && new RegExp(`^${fence.char}+$`).test(trimmed)) {
        ranges.push({ start: fenceStart, end: lineEnd, contentStart, contentEnd: pos, closed: true });
        fence = undefined;
      }
    }
    pos = lineEnd;
  }
  if (fence !== undefined) ranges.push({ start: fenceStart, end: text.length, contentStart, contentEnd: text.length, closed: false });
  return ranges;
}

export function fencedRanges(text: string): CodeRange[] {
  return fencedCodeRanges(text).map(({ start, end }) => ({ start, end }));
}

/** Exact backtick runs outside fences; unmatched openers remain literal prose. */
export function inlineCodeRanges(text: string, fences: readonly CodeRange[]): CodeRange[] {
  const ranges: CodeRange[] = [];
  let i = 0;
  while (i < text.length) {
    const fence = fences.find(range => i >= range.start && i < range.end);
    if (fence !== undefined) { i = fence.end; continue; }
    if (text[i] !== "`") { i += 1; continue; }
    let openLength = 1;
    while (text[i + openLength] === "`") openLength += 1;
    const limit = fences.find(range => range.start > i)?.start ?? text.length;
    let j = i + openLength;
    let closeStart = -1;
    while (j < limit) {
      if (text[j] !== "`") { j += 1; continue; }
      let closeLength = 1;
      while (text[j + closeLength] === "`") closeLength += 1;
      if (closeLength === openLength) { closeStart = j; break; }
      j += closeLength;
    }
    if (closeStart < 0) { i += openLength; continue; }
    const end = closeStart + openLength;
    ranges.push({ start: i, end });
    i = end;
  }
  return ranges;
}
