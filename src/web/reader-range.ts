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
