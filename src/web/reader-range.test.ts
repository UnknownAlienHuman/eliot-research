import { describe, expect, it } from "vitest";
import { splitReaderRange } from "./reader-range";

describe("splitReaderRange", () => {
  const text = "\uFEFFa😀\r\nБ";
  it.each([
    { start: 0, end: 12, before: "", selected: text, after: "" },
    { start: 0, end: 3, before: "", selected: "\uFEFF", after: "a😀\r\nБ" },
    { start: 3, end: 4, before: "\uFEFF", selected: "a", after: "😀\r\nБ" },
    { start: 4, end: 8, before: "\uFEFFa", selected: "😀", after: "\r\nБ" },
    { start: 8, end: 10, before: "\uFEFFa😀", selected: "\r\n", after: "Б" },
    { start: 10, end: 12, before: "\uFEFFa😀\r\n", selected: "Б", after: "" },
  ])("preserves exact UTF-8 bytes for [$start,$end)", ({ start, end, before, selected, after }) => {
    const split = splitReaderRange(text, start, end);
    expect(split).toEqual({ before, selected, after });
    expect(split.before + split.selected + split.after).toBe(text);
    expect(new TextEncoder().encode(split.before).length).toBe(start);
    expect(new TextEncoder().encode(split.selected).length).toBe(end - start);
  });
  it("preserves LF and surrounding sentences", () => {
    expect(splitReaderRange("Before.\nExact.\nAfter.", 8, 14)).toEqual({ before: "Before.\n", selected: "Exact.", after: "\nAfter." });
  });
  it.each([[1, 3], [4, 7], [5, 8], [10, 11]])("rejects a mid-character boundary [%s,%s)", (start, end) => {
    expect(() => splitReaderRange(text, start, end)).toThrow();
  });
  it.each([[-1, 3], [0, 13], [4, 4], [8, 4], [0.5, 4], [NaN, 4], [0, Infinity]])("rejects invalid range [%s,%s)", (start, end) => {
    expect(() => splitReaderRange(text, start, end)).toThrow(RangeError);
  });
});
