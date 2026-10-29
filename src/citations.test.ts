import { describe, expect, it } from "vitest";
import { answerWarnings, persistentAnswer, persistentResolvedAnswer, resolveCitations, uncitedStatements,
  numericCitationLabels, unsupportedNumericStatements } from "./citations.js";
import type { Citation, LabelSource } from "./citations.js";
import { isCitableBlock, scanBlocks, sliceUtf8, type Block } from "./blocks.js";

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
  it("bounds rejected marker samples without changing text, counts or resolved ranges", () => {
    const rejected = Array.from({ length: 12 }, (_, index) => `[S${index + 10}:1]`);
    const answer = `😀 ${rejected.join(" ")} [S10:1] [S1:1]`;
    const result = resolveCitations(answer, makeSources());
    expect(result.invalidLabels).toBe(13);
    expect(result.text).toBe(rejected.reduce((text, token) => text.replaceAll(token, ""), answer));
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.start).toBe(0);
    expect(result.invalidLabelExamples).toEqual(rejected.slice(0, 8));
    const long = resolveCitations(`[S${"9".repeat(200)}:1]`, makeSources());
    expect(long.invalidLabels).toBe(1);
    expect(Array.from(long.invalidLabelExamples?.[0] ?? "")).toHaveLength(160);
    expect(resolveCitations("[S1:1]", makeSources()).invalidLabelExamples).toBeUndefined();
  });
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

  it("drops malformed, truncated and bare labels but keeps ordinary brackets", () => {
    const out = resolveCitations("a [S1:] b [S1:x] c [Rabc:1] d [S1] e [note] f [S9] g", makeSources());
    expect(out.invalidLabels).toBe(5);
    expect(out.text).toBe("a  b  c  d  e [note] f  g");
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

  it("drops bare source markers but keeps valid labels, fenced code and links", () => {
    const answer = "Claim [S1:1] plus bare [S9] plus link [guide](https://example.com) .\n```\n[S9] [S1:1]\n```\nAfter.";
    const out = resolveCitations(answer, makeSources());
    expect(out.invalidLabels).toBe(1);
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0]).toMatchObject({ sourceId: SRC_A, label: "[S1:1]" });
    expect(out.text).toContain("[S1:1] plus bare  plus link [guide](https://example.com)");
    expect(out.text).toContain("```\n[S9] [S1:1]\n```");
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

describe("uncitedStatements", () => {
  function check(raw: string): number {
    const r = resolveCitations(raw, makeSources());
    return uncitedStatements(r.text, r.citations);
  }

  it("counts trailing uncited sentence in same paragraph", () => {
    expect(check("A [S1:1]. B.")).toBe(1);
  });

  it("later cite cannot cover earlier sentence", () => {
    expect(check("A. B [S1:1].")).toBe(1);
  });

  it("counts cross-paragraph uncited sentences both orders", () => {
    expect(check("A [S1:1].\n\nB.")).toBe(1);
    expect(check("A.\n\nB [S1:1].")).toBe(1);
  });

  it("label-only following line covers preceding statement", () => {
    expect(check("A. [S1:1]")).toBe(0);
    expect(check("A.\n[S1:1]")).toBe(0);
  });

  it("keeps postfix labels with their sentence before a neighboring fact", () => {
    expect(check("A [S1:1]. [S1:2] B.")).toBe(1);
    expect(check("A [S1:1].\n[S1:2] B.")).toBe(1);
    expect(check("A.\n[S1:1]\nB.")).toBe(1);
    expect(check("A. [S1:1] B [S1:2].")).toBe(0);
    expect(check(`A [R${REV_A}:1]. [R${REV_A}:2] B.`)).toBe(1);
    expect(check(`A. [R${REV_A}:1] B [R${REV_A}:2].`)).toBe(0);
  });

  it("keeps first-sentence prefix labels in their own paragraph or list block", () => {
    expect(check("First fact.[S1:1]\n\n[S1:2] Second fact.")).toBe(0);
    expect(check("First fact.[S1:1]\n\n- [S1:2] Second fact.")).toBe(0);
    expect(check("First fact.\n\n[S1:2] Second fact.")).toBe(1);
    expect(check("First fact.[S1:1]\n\n[S1:2] Second fact. Third fact.")).toBe(1);
    expect(check(`First fact.[R${REV_A}:1]\n\n[R${REV_A}:2] Second fact.`)).toBe(0);
  });

  it("preserves saved UTF-8 offsets and labels after non-ASCII answer text", () => {
    const resolved = resolveCitations("Факт 🌍 [S1:1]. [S1:2] Ещё факт.", makeSources());
    const saved = persistentResolvedAnswer(resolved.text, resolved.citations);
    expect(uncitedStatements(saved.text, saved.citations)).toBe(1);
    expect(saved.text).toBe(`Факт 🌍 [R${REV_A}:1]. [R${REV_A}:2] Ещё факт.`);
    expect(saved.citations.map(({ start, end }) => [start, end])).toEqual([[0, 10], [10, 20]]);
  });

  // IMPLEMENTATION §8: semicolons stay inside one sentence. A trailing label covers
  // that sentence; a distinct later sentence, including on the same bullet line, stays
  // uncovered unless the owning contract explicitly gives the row broader scope.
  it("row-end citation covers one semicolon-joined sentence", () => {
    expect(check("A [S1:1]; B.")).toBe(0);
    expect(check("A; B [S1:1].")).toBe(0);
    expect(check("A [S1:1]; B [S1:2].")).toBe(0);
    expect(check("- A; B [S1:1].")).toBe(0);
  });

  it("counts an uncited neighboring sentence inside a bullet row", () => {
    expect(check("- Cited fact [S1:1]. Uncited fact.")).toBe(1);
  });

  it("keeps inline, inline-code, and escaped pipes in prose sentence coverage", () => {
    const tick = String.fromCharCode(96);
    expect(check("P(A|B) = 0.4 [S1:1]. The model has 8 heads.")).toBe(1);
    expect(check("P(A\\|B) = 0.4 [S1:1]. The model has 8 heads.")).toBe(1);
    expect(check("Formula " + tick + "P(A|B) = 0.4" + tick + " [S1:1]. The model has 8 heads.")).toBe(1);
  });

  it("actual C3 Require row: semicolon clauses covered by row-end citation", () => {
    expect(check("\u0422\u0440\u0435\u0431\u0443\u044e\u0442\u0441\u044f: \u03b1 \u2014 \u0440\u0430\u0437\u043c\u0435\u0440 \u0448\u0430\u0433\u0430; \u03b21, \u03b22 \u2208 [0, 1) \u2014 \u0441\u043a\u043e\u0440\u043e\u0441\u0442\u0438 [S1:1].")).toBe(0);
  });

  // IMPLEMENTATION §8: anchored explicit inference/missing-answer markers exempt only
  // their sentence. Neighboring facts and ordinary negative assertions still need cover.
  it("explicit RU inference marker exempts its own sentence, neighbor fact stays 1", () => {
    expect(check("\u041f\u043e\u043b\u0430\u0433\u0430\u044e, \u0447\u0442\u043e \u044d\u0442\u043e \u043e\u0431\u043e\u0431\u0449\u0430\u0435\u0442\u0441\u044f.")).toBe(0);
    expect(check("\u042f \u043f\u0440\u0435\u0434\u043f\u043e\u043b\u0430\u0433\u0430\u044e \u0447\u0442\u043e \u044d\u0442\u043e \u043e\u0431\u043e\u0431\u0449\u0430\u0435\u0442\u0441\u044f.")).toBe(0);
    expect(check("\u0414\u0430\u043d\u043d\u044b\u0435 \u043d\u0435 \u0441\u043e\u0434\u0435\u0440\u0436\u0430\u0442 \u043f\u0440\u043e\u043f\u0443\u0441\u043a\u043e\u0432. \u041f\u043e\u043b\u0430\u0433\u0430\u044e, \u0447\u0442\u043e \u044d\u0442\u043e \u043e\u0431\u043e\u0431\u0449\u0430\u0435\u0442\u0441\u044f.")).toBe(1);
    expect(check("Inference uses 512 tokens.")).toBe(1);
  });

  it("explicit RU missing-answer abstention exempts its own sentence, neighbor fact stays 1", () => {
    expect(check("\u042f \u043d\u0435 \u043d\u0430\u0445\u043e\u0436\u0443 \u0432 \u0441\u0442\u0430\u0442\u044c\u0435 \u043e\u0442\u0432\u0435\u0442\u0430 \u043d\u0430 \u0432\u043e\u043f\u0440\u043e\u0441.")).toBe(0);
    expect(check("\u041c\u043e\u0434\u0435\u043b\u044c \u0438\u043c\u0435\u0435\u0442 8 \u0433\u043e\u043b\u043e\u0432. \u042f \u043d\u0435 \u043d\u0430\u0445\u043e\u0436\u0443 \u0432 \u0441\u0442\u0430\u0442\u044c\u0435 \u043e\u0442\u0432\u0435\u0442\u0430 \u043d\u0430 \u0432\u043e\u043f\u0440\u043e\u0441.")).toBe(1);
  });

  it("generic RU data-quality sentence stays uncovered", () => {
    expect(check("\u0414\u0430\u043d\u043d\u044b\u0435 \u043d\u0435 \u0441\u043e\u0434\u0435\u0440\u0436\u0430\u0442 \u043f\u0440\u043e\u043f\u0443\u0441\u043a\u043e\u0432.")).toBe(1);
  });

  it("exact all-cited EN returns zero", () => {
    expect(check("A [S1:1]. B [S1:2].")).toBe(0);
  });

  it("exact all-cited RU returns zero", () => {
    expect(check("\u041c\u043e\u0434\u0435\u043b\u044c \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0435\u0442 8 \u0433\u043e\u043b\u043e\u0432 [S1:1].")).toBe(0);
    expect(check("\u041c\u043e\u0434\u0435\u043b\u044c \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0435\u0442 8 \u0433\u043e\u043b\u043e\u0432 [S1:1]. \u0414\u0430\u043d\u043d\u044b\u0435 \u0432\u0437\u044f\u0442\u044b \u0438\u0437 \u043a\u043e\u0440\u043f\u0443\u0441\u0430 [S2:1].")).toBe(0);
    expect(check("\u0418\u043d\u0442\u0435\u0440\u043f\u0440\u0435\u0442\u0430\u0446\u0438\u044f: \u0432\u043e\u0437\u043c\u043e\u0436\u043d\u043e, \u044d\u0442\u043e \u043e\u0431\u044a\u044f\u0441\u043d\u0435\u043d\u0438\u0435.")).toBe(0);
  });

  it("RU uncited sentence counts", () => {
    expect(check("\u041c\u043e\u0434\u0435\u043b\u044c \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0435\u0442 8 \u0433\u043e\u043b\u043e\u0432. \u0414\u0430\u043d\u043d\u044b\u0435 \u0432\u0437\u044f\u0442\u044b \u0438\u0437 \u043a\u043e\u0440\u043f\u0443\u0441\u0430 [S2:1].")).toBe(1);
  });

  it("single end cite does not cover whole answer", () => {
    expect(check("A. B. C [S1:1].")).toBe(2);
  });

  it("invalid labels are not authority", () => {
    expect(check("A [S9:9].")).toBe(1);
    expect(check("A [S1:99].")).toBe(1);
  });

  it("fenced-code labels do not cover prose", () => {
    expect(check("A.\n```\n[S1:1]\n```")).toBe(1);
  });

  it("inline-code labels do not cover prose", () => {
    const r = resolveCitations("A `[S1:1]`.", makeSources());
    expect(r.text).toBe("A `[S1:1]`.");
    expect(r.citations).toEqual([]);
    expect(r.invalidLabels).toBe(0);
    expect(uncitedStatements(r.text, r.citations)).toBe(1);
  });

  it("exact token mismatch does not cover", () => {
    const other: Citation[] = resolveCitations("X [S1:2]", makeSources()).citations;
    expect(uncitedStatements("A [S1:1].", other)).toBe(1);
  });

  it("heading-only structure is exempt but numeric facts are not", () => {
    expect(check("# Background")).toBe(0);
    expect(check("## d_model = 512")).toBe(1);
    expect(check("## d_model = 512 [S1:1]")).toBe(0);
  });

  it("bullet rows need citations", () => {
    expect(check("- fact [S1:1]")).toBe(0);
    expect(check("- fact")).toBe(1);
  });

  it("recognizes Markdown tables from header and delimiter context", () => {
    const header = "| model | d_model |\n| --- | ---: |\n";
    expect(check(header + "| Transformer | 512 [S1:1] |")).toBe(0);
    expect(check(header + "| Transformer | 512 [S1:1] |\n| BERT | 768 |")).toBe(1);
    expect(check(header + "| Transformer | 512 |")).toBe(1);
  });

  it("math statements need citations", () => {
    expect(check("PE(pos,2i) = sin(pos) [S1:1].")).toBe(0);
    expect(check("PE(pos,2i) = sin(pos).")).toBe(1);
  });

  it("inference marker exempts only its own clause", () => {
    expect(check("Inference: this might generalize. The model has 8 heads [S1:1].")).toBe(0);
    expect(check("The model has 8 heads. Inference: this might generalize.")).toBe(1);
  });

  it("abstention marker exempts only its own clause", () => {
    expect(check("I abstain: no evidence here. The model has 8 heads [S1:1].")).toBe(0);
    expect(check("The model has 8 heads. I abstain on the rest.")).toBe(1);
  });
});

describe("uncitedStatements independent falsifications", () => {
  function checkRaw(raw: string): number {
    const r = resolveCitations(raw, makeSources());
    return uncitedStatements(r.text, r.citations);
  }

  it("broad negation is not abstention", () => {
    expect(checkRaw("We do not use dropout.")).toBe(1);
  });

  it("inference prefix inside a compound word is not a marker", () => {
    expect(checkRaw("Inference-time latency is zero.")).toBe(1);
  });

  it("inline-code factual statement still needs cover", () => {
    expect(checkRaw("`d_model = 512`")).toBe(1);
  });

  it("generic RU abstention exempts its own clause", () => {
    expect(checkRaw("\u0412\u043e\u0437\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u044e\u0441\u044c: \u0432 \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0430\u0445 \u043d\u0435\u0442 \u043e\u0442\u0432\u0435\u0442\u0430.")).toBe(0);
  });

  it("bracket inference marker exempts its own clause", () => {
    expect(checkRaw("[inference] this might generalize.")).toBe(0);
    expect(checkRaw("\u0412\u044b\u0432\u043e\u0434 [inference]: \u044d\u0442\u043e \u043e\u0431\u043e\u0431\u0449\u0430\u0435\u0442\u0441\u044f.")).toBe(0);
  });

  it("bare inference nouns are not markers", () => {
    expect(checkRaw("Inference uses 512 tokens.")).toBe(1);
    expect(checkRaw("Interpretation requires 8 GPUs.")).toBe(1);
  });

  it("Cyrillic marker prefixes do not match word continuations", () => {
    expect(checkRaw("\u041f\u043e\u043b\u0430\u0433\u0430\u044e, \u0447\u0442\u043e-\u0442\u043e \u0438\u0437\u043c\u0435\u043d\u0438\u043b\u043e\u0441\u044c.")).toBe(1);
    expect(checkRaw("\u042f \u043d\u0435 \u043d\u0430\u0445\u043e\u0436\u0443 \u0432 \u0441\u0442\u0430\u0442\u044c\u0435 \u043e\u0442\u0432\u0435\u0442\u0430\u043c\u0438 \u043d\u0430 \u0432\u043e\u043f\u0440\u043e\u0441.")).toBe(1);
  });

  it("factual RU data-quality assertion is not abstention", () => {
    expect(checkRaw("\u0414\u0430\u043d\u043d\u044b\u0435 \u043d\u0435 \u0441\u043e\u0434\u0435\u0440\u0436\u0430\u0442 \u043f\u0440\u043e\u043f\u0443\u0441\u043a\u043e\u0432.")).toBe(1);
  });
});

describe("unsupportedNumericStatements", () => {
  function check(raw: string, quotes: ReadonlyMap<string, string>): number {
    const resolved = resolveCitations(raw, makeSources());
    return unsupportedNumericStatements(resolved.text, resolved.citations, quotes);
  }

  const tick = String.fromCharCode(96);
  const formula = "score = (input + 3) / 5";
  const pageHeading = "### Page One\n";
  const syntheticDocument = "Overview.\n\n" + formula + "\n\n" + pageHeading;
  const syntheticBlocks = scanBlocks(syntheticDocument);
  const syntheticSources: LabelSource[] = [{ sourceId: SRC_A, revisionId: REV_A, title: "Synthetic source",
    blocks: syntheticBlocks.filter((block) => isCitableBlock(block, sliceUtf8(syntheticDocument, block.start, block.end))), alias: "S1" }];
  const cite = (answer: string): Citation => {
    const citation = resolveCitations(answer, syntheticSources).citations[0];
    if (!citation) throw new Error("Synthetic citation did not resolve.");
    return citation;
  };
  const formulaBlock = syntheticBlocks.find((block) => block.id === 2);
  const headingBlock = syntheticBlocks.find((block) => block.id === 3);
  if (!formulaBlock || !headingBlock) throw new Error("Synthetic document blocks were not scanned as expected.");
  const formulaQuote = sliceUtf8(syntheticDocument, formulaBlock.start, formulaBlock.end);
  const pageHeadingQuote = sliceUtf8(syntheticDocument, headingBlock.start, headingBlock.end);
  const badHeadingCitation = cite("Sample count is 12 [S1:3].");

  it("rejects numeric facts supported only by a byte-exact page-heading citation", () => {
    const answer = [
      `The synthetic rule is ${formula} [S1:3].`,
      "- Sample count is 12 [S1:3].",
      "- Review period is 7 days [S1:3].",
      "- Batch size is 4 items [S1:3].",
    ].join("\n");
    const quotes = new Map([[badHeadingCitation.label, pageHeadingQuote]]);
    expect(unsupportedNumericStatements(answer, [badHeadingCitation], quotes)).toBe(4);
    expect(numericCitationLabels(answer, [badHeadingCitation])).toEqual(["[S1:3]"]);
  });

  it("accepts a numeric formula only with its own matching selected quote", () => {
    const citation = cite(formula + " [S1:2].");
    const answer = formula + " " + citation.label + ".";
    expect(unsupportedNumericStatements(answer, [citation], new Map([[citation.label, formulaQuote]]))).toBe(0);
    expect(unsupportedNumericStatements(answer, [citation], new Map([[citation.label, pageHeadingQuote]]))).toBe(1);
  });

  it("does not borrow supported numbers across neighboring cited sentences", () => {
    const answer = "Container volume is 32 liters [S1:1]. Process duration is 7 minutes [S1:2].";
    expect(check(answer, new Map([["[S1:1]", "7 minutes"], ["[S1:2]", "32 liters"]]))).toBe(2);
    expect(check(answer, new Map([["[S1:1]", "32 liters"], ["[S1:2]", "7 minutes"]]))).toBe(0);
  });

  it("does not use unrelated map entries or unused resolved citations as evidence", () => {
    const citations = resolveCitations("Scope [S1:1] [S1:2]", makeSources()).citations;
    const answer = "Width is 512 [S1:1].";
    const quotes = new Map([["[S1:1]", "8 heads"], ["[S1:2]", "512 dimensions"]]);
    expect(unsupportedNumericStatements(answer, citations, quotes)).toBe(1);
    expect(numericCitationLabels(answer, citations)).toEqual(["[S1:1]"]);
  });

  it("combines only the selected quotes inside the same factual unit", () => {
    expect(check("Width is 512 and heads are 8 [S1:1] [S1:2].",
      new Map([["[S1:1]", "512 dimensions"], ["[S1:2]", "8 heads"]]))).toBe(0);
  });

  it("fails numeric units with no citation or no hydrated selected quote", () => {
    expect(check("Width is 512 [S1:1].", new Map())).toBe(1);
    expect(check("Width is 512.", new Map([["[S1:1]", "512"]]))).toBe(1);
    expect(check("Width is 512 [S9:9].", new Map([["[S9:9]", "512"]]))).toBe(1);
  });

  it("does not treat compact or persistent citation digits as factual numbers", () => {
    const resolved = resolveCitations("Cited prose [S1:1].", makeSources());
    const saved = persistentResolvedAnswer(resolved.text, resolved.citations);
    expect(unsupportedNumericStatements(resolved.text, resolved.citations, new Map())).toBe(0);
    expect(unsupportedNumericStatements(saved.text, saved.citations, new Map())).toBe(0);
    expect(numericCitationLabels(saved.text, saved.citations)).toEqual([]);
  });

  it("uses the same postfix locality and first-paragraph prefix boundaries", () => {
    const quotes = new Map([["[S1:1]", "512"], ["[S1:2]", "8"]]);
    expect(check("Width 512 [S1:1]. [S1:2] Heads 8.", quotes)).toBe(1);
    expect(check("Width 512.[S1:1]\n\n[S1:2] Heads 8.", quotes)).toBe(0);
    expect(check("Width 512. [S1:1] Heads 8 [S1:2].", quotes)).toBe(0);
  });

  it("ignores fenced examples and never uses fenced or inline-code label tokens as authority", () => {
    const quotes = new Map([["[S1:1]", "512"]]), fence = tick.repeat(3);
    expect(check("Width 512 " + tick + "[S1:1]" + tick + ".", quotes)).toBe(1);
    const citations = resolveCitations("Scope [S1:1]", makeSources()).citations;
    expect(unsupportedNumericStatements("Width 512.\n" + fence + "\n[S1:1]\n" + fence, citations, quotes)).toBe(1);
    expect(check(fence + "\nvalue = 512;\n" + fence + "\nCited prose [S1:1].", new Map())).toBe(0);
  });

  it("keeps the same numeric heading and Markdown table-row rules", () => {
    const quotes = new Map([["[S1:1]", "8"]]);
    expect(check("## d_model = 512 [S1:1]", quotes)).toBe(1);
    const header = "| model | width |\n| --- | ---: |\n";
    expect(check(header + "| model | 512 [S1:1] |", quotes)).toBe(1);
    expect(check(header + "| model | 512 [S1:1] |", new Map([["[S1:1]", "512"]]))).toBe(0);
  });

  it("exempts explicit inference/abstention only in their own units", () => {
    expect(check("Inference: 900 might generalize. Width is 512 [S1:1].", new Map([["[S1:1]", "512"]]))).toBe(0);
    expect(check("Воздерживаюсь: в источниках нет ответа о 900. Модель имеет 512 параметров.", new Map())).toBe(1);
    expect(check("Inference uses 512 tokens [S1:1].", new Map([["[S1:1]", "8"]]))).toBe(1);
  });

  it("uses the shared atomic decimal/scientific rule without repairing numbers", () => {
    expect(check("Result is 41.8 [S1:1].", new Map([["[S1:1]", "41.0 and 8"]]))).toBe(1);
    expect(check("Result is 1e8 [S1:1].", new Map([["[S1:1]", "1e-8"]]))).toBe(1);
    expect(check("Result is 1e-8 [S1:1].", new Map([["[S1:1]", "1e-8"]]))).toBe(0);
  });

  it("returns unique quote labels only for numeric factual units", () => {
    const resolved = resolveCitations("Width 512 [S1:1]. Heads 8 [S1:1]. Prose [S1:2].", makeSources());
    expect(numericCitationLabels(resolved.text, resolved.citations)).toEqual(["[S1:1]"]);
    expect(unsupportedNumericStatements(resolved.text, resolved.citations,
      new Map([["[S1:1]", "512 dimensions, 8 heads"]]))).toBe(0);
  });
});


describe("inline code literals", () => {
  it("leaves inline bare and valid labels untouched while outside bare stays invalid", () => {
    const bare = resolveCitations("Literal `[S9]`", []);
    expect(bare.text).toBe("Literal `[S9]`");
    expect(bare.invalidLabels).toBe(0);
    expect(bare.citations).toEqual([]);
    const mixed = resolveCitations("Fact [S1:1] plus `[S1:2]` plus `[S9]`", makeSources());
    expect(mixed.invalidLabels).toBe(0);
    expect(mixed.text).toBe("Fact [S1:1] plus `[S1:2]` plus `[S9]`");
    expect(mixed.citations).toHaveLength(1);
    expect(mixed.citations[0]).toMatchObject({ sourceId: SRC_A, label: "[S1:1]" });
    const outside = resolveCitations("x [S9] y", []);
    expect(outside.invalidLabels).toBe(1);
    expect(outside.text).toBe("x  y");
  });

  it("leaves inline labels untouched in persistentResolvedAnswer", () => {
    const turn = resolveCitations("see [S1:1] plus `[S1:2]`", makeSources());
    expect(turn.invalidLabels).toBe(0);
    const saved = persistentResolvedAnswer(turn.text, turn.citations);
    expect(saved.text).toBe("see [R" + REV_A + ":1] plus `[S1:2]`");
    expect(saved.citations).toHaveLength(1);
    expect(saved.invalidLabels).toBe(0);
  });
});

describe("answerWarnings", () => {
  function resolvedWarnings(raw: string, quotes: ReadonlyMap<string, string> = new Map()) {
    const resolved = resolveCitations(raw, makeSources());
    return { text: resolved.text, citations: resolved.citations, warnings: answerWarnings(resolved.text, resolved.citations, quotes) };
  }

  function expectValidRanges(text: string, warnings: Array<{ start: number; end: number; kind: string }>): void {
    for (const warning of warnings) {
      expect(Number.isSafeInteger(warning.start)).toBe(true);
      expect(Number.isSafeInteger(warning.end)).toBe(true);
      expect(warning.start).toBeGreaterThanOrEqual(0);
      expect(warning.end).toBeLessThanOrEqual(text.length);
      expect(warning.end).toBeGreaterThan(warning.start);
      expect(["missing-citation", "unsupported-number"]).toContain(warning.kind);
    }
  }

  it("marks only the uncited sentence and keeps existing counts", () => {
    const { text, citations, warnings } = resolvedWarnings("A [S1:1]. B.");
    expect(uncitedStatements(text, citations)).toBe(1);
    expect(unsupportedNumericStatements(text, citations, new Map())).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("missing-citation");
    expectValidRanges(text, warnings);
    expect(text.slice(warnings[0]?.start ?? 0, warnings[0]?.end ?? 0)).toContain("B.");
  });

  it("marks numeric units unsupported by same-unit quotes", () => {
    const quotes = new Map([["[S1:1]", "8 heads"]]);
    const { text, citations, warnings } = resolvedWarnings("Width is 512 [S1:1].", quotes);
    expect(uncitedStatements(text, citations)).toBe(0);
    expect(unsupportedNumericStatements(text, citations, quotes)).toBe(1);
    expect(warnings).toEqual([{ start: 0, end: text.length, kind: "unsupported-number" }]);
    const supported = resolvedWarnings("Width is 512 [S1:1].", new Map([["[S1:1]", "512 dimensions"]]));
    expect(supported.warnings).toEqual([]);
  });

  it("keeps unicode and multi-markdown unit ranges in bounds", () => {
    const raw = "Факт 🌍 [S1:1]. Ещё факт 8 голов.\n\n- Cited fact [S1:2]\n- Uncited fact";
    const { text, citations, warnings } = resolvedWarnings(raw);
    expect(uncitedStatements(text, citations)).toBe(2);
    expect(warnings.filter((warning) => warning.kind === "missing-citation")).toHaveLength(2);
    expect(warnings.filter((warning) => warning.kind === "unsupported-number")).toHaveLength(0);
    expectValidRanges(text, warnings);
    const slices = warnings.map((warning) => text.slice(warning.start, warning.end));
    expect(slices.some((slice) => slice.includes("Ещё факт"))).toBe(true);
    expect(slices.some((slice) => slice.includes("Uncited fact"))).toBe(true);
  });

  it("emits no ranges for fenced examples and stays silent on fully cited prose", () => {
    const cited = resolvedWarnings("Cited prose [S1:1].");
    expect(cited.warnings).toEqual([]);
    const fence = String.fromCharCode(96).repeat(3);
    const fenced = resolvedWarnings("Cited prose [S1:1].\n" + fence + "\nvalue = 512;\n" + fence + "\n");
    expect(fenced.warnings).toEqual([]);
    expectValidRanges(fenced.text, fenced.warnings);
  });
});
