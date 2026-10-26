import { describe, expect, it } from "vitest";
import { MAX_BLOCK_BYTES, scanBlocks, sliceUtf8 } from "./blocks.js";
import type { Block } from "./blocks.js";
const TE = new TextEncoder();
function byteLength(value: string): number {
  return TE.encode(value).byteLength;
}
function checkInvariants(text: string, blocks: Block[]): void {
  expect(blocks.length).toBeGreaterThan(0);
  blocks.forEach((block, index) => {
    expect(block.id).toBe(index + 1);
    expect(block.end).toBeGreaterThan(block.start);
    expect(byteLength(sliceUtf8(text, block.start, block.end))).toBe(block.end - block.start);
    if (index > 0) {
      const prev = blocks[index - 1];
      expect(block.start).toBeGreaterThanOrEqual(prev?.end ?? 0);
    }
  });
}
describe("scanBlocks", () => {
  it("keeps a GFM table without outer pipes intact", () => {
    const text = "# Results\n\nMetric | Value\n--- | ---\nAccuracy | 95\n";
    const blocks = scanBlocks(text);
    expect(blocks.map((block) => block.type)).toEqual(["heading", "table"]);
    const table = blocks[1];
    expect(table && sliceUtf8(text, table.start, table.end)).toBe("Metric | Value\n--- | ---\nAccuracy | 95\n");
  });
  it("preserves standalone CR byte offsets", () => {
    const text = "# Заголовок\r\rАбзац.\r";
    const blocks = scanBlocks(text);
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph"]);
    checkInvariants(text, blocks);
  });
  it("tracks the nearest heading and keeps byte-exact order", () => {
    const text = "Preamble text.\n\n# Глава\n\nАбзац под главой.\n\n## Детали\n\n- пункт один\n- пункт два\n";
    const blocks = scanBlocks(text);
    checkInvariants(text, blocks);
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "heading", "paragraph", "heading", "list"]);
    expect(blocks[0]?.heading).toBeNull();
    expect(blocks[1]?.heading).toBe("Глава");
    expect(blocks[2]?.heading).toBe("Глава");
    expect(blocks[4]?.heading).toBe("Детали");
    const head = blocks[1];
    if (head !== undefined) expect(sliceUtf8(text, head.start, head.end)).toBe("# Глава\n");
  });
  it("keeps Cyrillic and emoji on character boundaries", () => {
    const text = "# Привет 🌍\n\nТекст с эмодзи 🙂 и кириллицей.\n";
    const blocks = scanBlocks(text);
    checkInvariants(text, blocks);
    expect(blocks[0]?.type).toBe("heading");
    for (const block of blocks) expect(sliceUtf8(text, block.start, block.end)).not.toContain("�");
    const emojiByte = byteLength("# Привет ");
    expect(() => sliceUtf8(text, emojiByte + 1, emojiByte + 3)).toThrow(RangeError);
  });
  it("counts CRLF as two bytes", () => {
    const text = "# Title\r\n\r\nFirst line\r\nSecond line\r\n";
    const blocks = scanBlocks(text);
    checkInvariants(text, blocks);
    expect(sliceUtf8(text, 0, byteLength("# Title\r\n"))).toBe("# Title\r\n");
    const para = blocks.find((block) => block.type === "paragraph");
    if (para !== undefined) expect(sliceUtf8(text, para.start, para.end)).toBe("First line\r\nSecond line\r\n");
  });
  it("keeps fenced code intact and ignores headings inside", () => {
    const text = "# Outer\n\n```markdown\n# Not a heading\ncode line\n```\n\nAfter.\n";
    const blocks = scanBlocks(text);
    checkInvariants(text, blocks);
    expect(blocks.map((block) => block.type)).toEqual(["heading", "code", "paragraph"]);
    expect(blocks[1]?.heading).toBe("Outer");
    const code = blocks[1];
    if (code !== undefined) expect(sliceUtf8(text, code.start, code.end)).toBe("```markdown\n# Not a heading\ncode line\n```\n");
  });
  it("groups tables, lists, and quotes", () => {
    const text = "# Data\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n- y\n\n> quoted line\n> second\n";
    const blocks = scanBlocks(text);
    checkInvariants(text, blocks);
    expect(blocks.map((block) => block.type)).toEqual(["heading", "table", "list", "quote"]);
    const table = blocks[1];
    if (table !== undefined) expect(sliceUtf8(text, table.start, table.end)).toBe("| a | b |\n|---|---|\n| 1 | 2 |\n");
  });
  it("splits long prose near sentences around 1 KiB", () => {
    const sentence = "Это предложение содержит кириллицу и занимает место в буфере. ";
    const body = sentence.repeat(40) + "\n";
    const blocks = scanBlocks("# H\n\n" + body);
    const paras = blocks.filter((block) => block.type === "paragraph");
    expect(paras.length).toBeGreaterThan(1);
    const text = "# H\n\n" + body;
    for (const para of paras) expect(para.end - para.start).toBeLessThanOrEqual(MAX_BLOCK_BYTES);
    expect(paras.map((para) => sliceUtf8(text, para.start, para.end)).join("")).toBe(body);
    for (const para of paras.slice(0, -1)) expect(sliceUtf8(text, para.start, para.end)).toMatch(/[.!?…]["'”’»\])]*\s+$/u);
  });
  it("splits oversized code safely at line boundaries", () => {
    const row = "x".repeat(200) + "\n";
    const text = "```\n" + row.repeat(30) + "```\n";
    const blocks = scanBlocks(text);
    const codes = blocks.filter((block) => block.type === "code");
    expect(codes.length).toBeGreaterThan(1);
    for (const code of codes) expect(code.end - code.start).toBeLessThanOrEqual(MAX_BLOCK_BYTES);
    expect(codes.map((code) => sliceUtf8(text, code.start, code.end)).join("")).toBe(text);
  });
});
describe("sliceUtf8", () => {
  it("is end-exclusive and rejects bad ranges", () => {
    expect(sliceUtf8("abcdef", 0, 3)).toBe("abc");
    expect(sliceUtf8("abcdef", 3, 3)).toBe("");
    expect(sliceUtf8("abcdef", 0, 6)).toBe("abcdef");
    expect(() => sliceUtf8("abc", 2, 1)).toThrow(RangeError);
    expect(() => sliceUtf8("abc", -1, 1)).toThrow(RangeError);
    expect(() => sliceUtf8("abc", 0, 4)).toThrow(RangeError);
    expect(() => sliceUtf8("🙂", 1, 4)).toThrow(RangeError);
    expect(sliceUtf8("🙂a", 0, 4)).toBe("🙂");
  });
});
