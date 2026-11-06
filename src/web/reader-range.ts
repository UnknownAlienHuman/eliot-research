export function splitReaderRange(text: string, start: number, end: number) {
  const bytes = new TextEncoder().encode(text);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > bytes.length)
    throw new RangeError("Range does not fit the loaded text.");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return {
    before: decoder.decode(bytes.subarray(0, start)),
    selected: decoder.decode(bytes.subarray(start, end)),
    after: decoder.decode(bytes.subarray(end)),
  };
}

// Search the original string, not a lowercased copy: case folding can change
// string length. Only the chosen match is converted to immutable UTF-8 offsets.
export function findReaderRange(text: string, query: string, position = 0, backwards = false) {
  if (!query.trim()) return null;
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  let found: RegExpExecArray | null = null;
  if (backwards) {
    let last: RegExpExecArray | null = null;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      last = match;
      if (match.index < position) found = match;
    }
    found ??= last;
  } else {
    pattern.lastIndex = position;
    found = pattern.exec(text);
    if (!found) { pattern.lastIndex = 0; found = pattern.exec(text); }
  }
  if (!found) return null;
  const encoder = new TextEncoder(), start = encoder.encode(text.slice(0, found.index)).length;
  return { start, end: start + encoder.encode(found[0]).length };
}
