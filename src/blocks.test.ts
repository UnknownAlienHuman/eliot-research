import { describe, expect, it } from "vitest";
import { isCitableBlock, MAX_BLOCK_BYTES, scanBlocks, sliceUtf8 } from "./blocks.js";
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
  it("joins the reviewed Transformer Table 1 and Table 4 captions to their tables byte-for-byte", () => {
    const table1 = [
      "Table 1: Maximum path lengths, per-layer complexity and minimum number of sequential operations for different layer types. $n$ is the sequence length, $d$ is the representation dimension, $k$ is the kernel size of convolutions and $r$ the size of the neighborhood in restricted self-attention.",
      "",
      "| Layer Type | Complexity per Layer | Sequential Operations | Maximum Path Length |",
      "|---|---|---|---|",
      "| Self-Attention | $O(n^2 \\cdot d)$ | $O(1)$ | $O(1)$ |",
      "| Recurrent | $O(n \\cdot d^2)$ | $O(n)$ | $O(n)$ |",
      "| Convolutional | $O(k \\cdot n \\cdot d^2)$ | $O(1)$ | $O(log_k(n))$ |",
      "| Self-Attention (restricted) | $O(r \\cdot n \\cdot d)$ | $O(1)$ | $O(n/r)$ |",
      "",
    ].join("\n");
    const table4 = [
      "Table 4: The Transformer generalizes well to English constituency parsing (Results are on Section 23 of WSJ)",
      "",
      "| Parser | Training | WSJ 23 F1 |",
      "|---|---|---|",
      "| Vinyals & Kaiser el al. (2014) [37] | WSJ only, discriminative | 88.3 |",
      "| Petrov et al. (2006) [29] | WSJ only, discriminative | 90.4 |",
      "| Zhu et al. (2013) [40] | WSJ only, discriminative | 90.4 |",
      "| Dyer et al. (2016) [8] | WSJ only, discriminative | 91.7 |",
      "| Transformer (4 layers) | WSJ only, discriminative | 91.3 |",
      "| Zhu et al. (2013) [40] | semi-supervised | 91.3 |",
      "| Huang & Harper (2009) [14] | semi-supervised | 91.3 |",
      "| McClosky et al. (2006) [26] | semi-supervised | 92.1 |",
      "| Vinyals & Kaiser el al. (2014) [37] | semi-supervised | 92.1 |",
      "| Transformer (4 layers) | semi-supervised | 92.7 |",
      "| Luong et al. (2015) [23] | multi-task | 93.0 |",
      "| Dyer et al. (2016) [8] | generative | 93.3 |",
      "",
    ].join("\n");
    const captures = [
      { heading: "# Page 6\n\n", headingValue: "Page 6", content: table1 },
      { heading: "# Page 10\n\n", headingValue: "Page 10", content: table4 },
    ];

    for (const capture of captures) {
      const text = "Преамбула 🌿\n\n" + capture.heading + capture.content + "\n\nAfter.\n";
      const blocks = scanBlocks(text);
      checkInvariants(text, blocks);
      expect(blocks.map((block) => block.type)).toEqual(["paragraph", "heading", "table", "paragraph"]);
      expect(sliceUtf8(text, blocks[0]?.start ?? 0, blocks[0]?.end ?? 0)).toBe("Преамбула 🌿\n");
      expect(sliceUtf8(text, blocks[1]?.start ?? 0, blocks[1]?.end ?? 0)).toBe(capture.heading.trimEnd() + "\n");
      const table = blocks[2];
      expect(table?.heading).toBe(capture.headingValue);
      expect(table && sliceUtf8(text, table.start, table.end)).toBe(capture.content);
      expect(table && table.end - table.start).toBe(byteLength(capture.content));
      expect(sliceUtf8(text, blocks[3]?.start ?? 0, blocks[3]?.end ?? 0)).toBe("After.\n");
    }
  });
  it("joins an explicit caption after its sole adjacent table", () => {
    const text = "| a | b |\n|---|---|\n| 1 | 2 |\n\nTable 8: Caption after the table.\n\nTail.\n";
    const blocks = scanBlocks(text);
    checkInvariants(text, blocks);
    expect(blocks.map((block) => block.type)).toEqual(["table", "paragraph"]);
    const table = blocks[0];
    expect(table && sliceUtf8(text, table.start, table.end)).toBe("| a | b |\n|---|---|\n| 1 | 2 |\n\nTable 8: Caption after the table.\n");
  });
  it("does not group ordinary prose, code, or a caption between two tables", () => {
    const prose = "Table 7 is discussed below.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    expect(scanBlocks(prose).map((block) => block.type)).toEqual(["paragraph", "table"]);

    const code = "```markdown\nTable 8: Not a caption\n\n| a | b |\n|---|---|\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    expect(scanBlocks(code).map((block) => block.type)).toEqual(["code", "table"]);

    const ambiguous = "| left |\n|---|\n| 1 |\n\nTable 9: Between two tables.\n\n| right |\n|---|\n| 2 |\n";
    const ambiguousBlocks = scanBlocks(ambiguous);
    checkInvariants(ambiguous, ambiguousBlocks);
    expect(ambiguousBlocks.map((block) => block.type)).toEqual(["table", "paragraph", "table"]);
    expect(sliceUtf8(ambiguous, ambiguousBlocks[1]?.start ?? 0, ambiguousBlocks[1]?.end ?? 0)).toBe("Table 9: Between two tables.\n");
  });
  it("does not exceed 4096 bytes when attaching a caption", () => {
    const caption = "Table 10: " + "caption ".repeat(130) + "\n";
    const table = "| Header | Value |\n|---|---|\n| row | " + "x".repeat(3100) + " |\n";
    const text = caption + "\n" + table;
    const blocks = scanBlocks(text);
    checkInvariants(text, blocks);
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "table"]);
    expect(blocks.every((block) => block.end - block.start <= MAX_BLOCK_BYTES)).toBe(true);
    expect(sliceUtf8(text, blocks[0]?.start ?? 0, blocks[0]?.end ?? 0)).toBe(caption);
    expect(sliceUtf8(text, blocks[1]?.start ?? 0, blocks[1]?.end ?? 0)).toBe(table);

    const splitCaption = "Table 11: Split table.\n";
    const splitTable = [
      "| Header | Value |",
      "|---|---|",
      "| a | " + "x".repeat(1800) + " |",
      "| b | " + "y".repeat(1800) + " |",
      "| c | " + "z".repeat(1800) + " |",
      "",
    ].join("\n");
    const splitText = splitCaption + "\n" + splitTable;
    const splitBlocks = scanBlocks(splitText);
    checkInvariants(splitText, splitBlocks);
    expect(splitBlocks.map((block) => block.type)).toEqual(["paragraph", "table", "table"]);
    const firstTableChunk = splitBlocks[1], lastTableChunk = splitBlocks[2];
    expect(firstTableChunk && byteLength(splitCaption + "\n" + sliceUtf8(splitText, firstTableChunk.start, firstTableChunk.end)))
      .toBeLessThanOrEqual(MAX_BLOCK_BYTES);
    expect(firstTableChunk && lastTableChunk?.start).toBe(firstTableChunk?.end);
    expect(firstTableChunk && lastTableChunk && sliceUtf8(splitText, firstTableChunk.start, firstTableChunk.end)
      + sliceUtf8(splitText, lastTableChunk.start, lastTableChunk.end)).toBe(splitTable);
  });
  it("does not guess across fragmented tables or bind only one chunk of a caption", () => {
    const oversizedTable = [
      "| Header | Value |",
      "|---|---|",
      "| a | " + "x".repeat(1800) + " |",
      "| b | " + "y".repeat(1800) + " |",
      "| c | " + "z".repeat(1800) + " |",
      "",
    ].join("\n");
    const betweenCaption = "Table 12: Between two tables.\n";
    const followingTable = "| Right |\n|---|\n| 2 |\n";
    const ambiguousText = oversizedTable + "\n" + betweenCaption + "\n" + followingTable;
    const ambiguousBlocks = scanBlocks(ambiguousText);
    checkInvariants(ambiguousText, ambiguousBlocks);
    expect(ambiguousBlocks.map((block) => block.type)).toEqual(["table", "table", "paragraph", "table"]);
    expect(sliceUtf8(ambiguousText, ambiguousBlocks[2]?.start ?? 0, ambiguousBlocks[2]?.end ?? 0)).toBe(betweenCaption);
    expect(sliceUtf8(ambiguousText, ambiguousBlocks[3]?.start ?? 0, ambiguousBlocks[3]?.end ?? 0)).toBe(followingTable);

    const longCaption = "Table 13: " + "caption ".repeat(250) + "\n";
    const smallTable = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    for (const text of [smallTable + "\n" + longCaption, longCaption + "\n" + smallTable]) {
      const blocks = scanBlocks(text);
      checkInvariants(text, blocks);
      const tableIndex = text.startsWith(smallTable) ? 0 : blocks.length - 1;
      const captionBlocks = text.startsWith(smallTable) ? blocks.slice(1) : blocks.slice(0, -1);
      expect(captionBlocks.length).toBeGreaterThan(1);
      expect(captionBlocks.every((block) => block.type === "paragraph")).toBe(true);
      expect(captionBlocks.map((block) => sliceUtf8(text, block.start, block.end)).join("")).toBe(longCaption);
      const tableBlock = blocks[tableIndex];
      expect(tableBlock && sliceUtf8(text, tableBlock.start, tableBlock.end)).toBe(smallTable);
    }
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
  it("keeps semantic headings citable and rejects empty or PDF page-wrapper blocks", () => {
    const text = "### Page 1\n\n## Методы 🌿\n\nСтраница 2\n";
    const blocks = scanBlocks(text);
    checkInvariants(text, blocks);
    expect(blocks.map((block) => block.id)).toEqual([1, 2, 3]);
    const [pageOne, heading, pageTwo] = blocks;
    if (pageOne === undefined || heading === undefined || pageTwo === undefined) {
      throw new Error("Expected two page-wrapper blocks and a semantic heading.");
    }
    expect(isCitableBlock(pageOne, sliceUtf8(text, pageOne.start, pageOne.end))).toBe(false);
    expect(isCitableBlock(heading, sliceUtf8(text, heading.start, heading.end))).toBe(true);
    expect(isCitableBlock(pageTwo, sliceUtf8(text, pageTwo.start, pageTwo.end))).toBe(false);
    const emptyHeading: Block = { id: 4, type: "heading", start: 0, end: 4, heading: "" };
    expect(isCitableBlock(emptyHeading, "### \n")).toBe(false);
    expect(isCitableBlock(pageTwo, "Page 2 appears in a sentence about the method.")).toBe(true);
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
