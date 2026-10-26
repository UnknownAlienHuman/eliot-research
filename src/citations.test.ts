import { describe, expect, it } from "vitest";
import { persistentAnswer, persistentResolvedAnswer, resolveCitations } from "./citations.js";
import type { LabelSource } from "./citations.js";
import type { Block } from "./blocks.js";

const SRC_A = "223e4567-e89b-12d3-a456-426614174000";
const SRC_B = "223e4567-e89b-12d3-a456-426614174001";
const REV_A = "123e4567-e89b-12d3-a456-426614174000";
const REV_B = "123e4567-e89b-12d3-a456-426614174001";

function makeBlocks(count: number): Block[] {
  const out: Block[] = [];
  for (let i = 1; i <= count; i++) {
    out.push({ id: i, type: "paragraph", start: (i - 1) * 10, end: i * 10, heading: null });
  }
  return out;
}

function makeSources(): LabelSource[] {
  return [
    { sourceId: SRC_A, revisionId: REV_A, title: "Paper A", blocks: makeBlocks(3), alias: "S1" },
    { sourceId: SRC_B, revisionId: REV_B, title: "Paper B", blocks: makeBlocks(2), alias: "S2" },
  ];
}

describe("resolveCitations", () => {
  it("resolves compact and persistent labels with map offsets", () => {
    const out = resolveCitations(`a [S1:2] b [R${REV_B}:1]`, makeSources());
    expect(out.invalidLabels).toBe(0);
    expect(out.text).toBe(`a [S1:2] b [R${REV_B}:1]`);
    expect(out.citations).toEqual([
      { revisionId: REV_A, sourceId: SRC_A, block: 2, start: 10, end: 20, sourceTitle: "Paper A", deleted: false, label: "[S1:2]" },
      { revisionId: REV_B, sourceId: SRC_B, block: 1, start: 0, end: 10, sourceTitle: "Paper B", deleted: false, label: `[R${REV_B}:1]` },
    ]);
  });

  it("drops unknown and out-of-scope labels and counts them", () => {
    const out = resolveCitations("a [S9:1] b [R00000000-0000-0000-0000-000000000000:1] c [S1:1]", makeSources());
    expect(out.invalidLabels).toBe(2);
    expect(out.text).toBe("a  b  c [S1:1]");
    expect(out.citations).toHaveLength(1);
  });

  it("drops out-of-range blocks without fabricating offsets", () => {
    const out = resolveCitations("x [S1:99] y", makeSources());
    expect(out.invalidLabels).toBe(1);
    expect(out.text).toBe("x  y");
    expect(out.citations).toEqual([]);
  });

  it("dedups repeated citations", () => {
    const out = resolveCitations("[S1:1] and [S1:1]", makeSources());
    expect(out.invalidLabels).toBe(0);
    expect(out.text).toBe("[S1:1] and [S1:1]");
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0]).toMatchObject({ sourceId: SRC_A, label: "[S1:1]" });
  });

  it("drops malformed and truncated labels but keeps plain brackets", () => {
    const out = resolveCitations("a [S1:] b [S1:x] c [Rabc:1] d [S1] e", makeSources());
    expect(out.invalidLabels).toBe(3);
    expect(out.text).toBe("a  b  c  d [S1] e");
    expect(out.citations).toEqual([]);
  });

  it("treats duplicated aliases as ambiguous", () => {
    const dup: LabelSource[] = [
      { sourceId: SRC_A, revisionId: REV_A, title: "A", blocks: makeBlocks(2), alias: "S1" },
      { sourceId: SRC_B, revisionId: REV_B, title: "B", blocks: makeBlocks(2), alias: "S1" },
    ];
    const out = resolveCitations("x [S1:1]", dup);
    expect(out.invalidLabels).toBe(1);
    expect(out.text).toBe("x ");
    expect(out.citations).toEqual([]);
  });

  it("ignores labels inside fenced code", () => {
    const answer = "ok [S1:2]\n```\n[S1:1] [S9:9]\n```\nafter";
    const out = resolveCitations(answer, makeSources());
    expect(out.invalidLabels).toBe(0);
    expect(out.text).toBe(answer);
    expect(out.citations).toHaveLength(1);
  });

  it("keeps Cyrillic, emoji and URLs byte-exact", () => {
    const answer = "\u041f\u0440\u0438\u0432\u0435\u0442 \uD83C\uDF0D https://example.com/x?q=1 [S2:2] \u043a\u043e\u043d\u0435\u0446";
    const out = resolveCitations(answer, makeSources());
    expect(out.invalidLabels).toBe(0);
    expect(out.text).toBe(answer);
    expect(out.citations[0]).toMatchObject({ revisionId: REV_B, sourceId: SRC_B, block: 2, start: 10, end: 20 });
  });
});

describe("persistentAnswer", () => {
  it("rewrites known compact labels to full revision ids", () => {
    const out = persistentAnswer("see [S1:1] and [S2:2] plus [S9:1]", makeSources());
    expect(out.invalidLabels).toBe(1);
    expect(out.text).toBe(`see [R${REV_A}:1] and [R${REV_B}:2] plus `);
    expect(out.citations).toHaveLength(2);
    expect(out.citations[0]).toMatchObject({ sourceId: SRC_A, label: `[R${REV_A}:1]` });
    expect(out.citations[1]).toMatchObject({ sourceId: SRC_B, label: `[R${REV_B}:2]` });
  });

  it("keeps valid persistent labels as-is", () => {
    const answer = `done [R${REV_A}:3]`;
    const out = persistentAnswer(answer, makeSources());
    expect(out.invalidLabels).toBe(0);
    expect(out.text).toBe(answer);
    expect(out.citations[0]).toMatchObject({ revisionId: REV_A, sourceId: SRC_A, block: 3, start: 20, end: 30 });
  });
});

describe("persistentResolvedAnswer", () => {
  it("rewrites the turn occurrence but preserves the same label inside fenced code", () => {
    const turn = resolveCitations("see [S1:1]\n```\n[S1:1]\n```\nafter", makeSources());
    expect(turn.invalidLabels).toBe(0);
    const saved = persistentResolvedAnswer(turn.text, turn.citations);
    expect(saved.text).toBe("see [R" + REV_A + ":1]\n```\n[S1:1]\n```\nafter");
    expect(saved.citations).toHaveLength(1);
    expect(saved.citations[0]).toMatchObject({ sourceId: SRC_A, label: "[R" + REV_A + ":1]" });
    expect(saved.invalidLabels).toBe(0);
  });
});
