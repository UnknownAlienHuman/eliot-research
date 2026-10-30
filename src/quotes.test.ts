import { numbersSupported } from "./numbers.js";
import { describe, expect, it } from "vitest";
import { cleanDistillText, resolveQuoteBlock, resultStatement, sourceContextJson, splitDistillStatements, verifyClaims } from "./quotes.js";
import type { CandidateClaim, VerifiedClaim } from "./quotes.js";
import { sliceUtf8 } from "./blocks.js";
import type { Block } from "./blocks.js";

const TE = new TextEncoder();

function blockFor(id: number, text: string, sub: string): Block {
  const at = text.indexOf(sub);
  const start = TE.encode(text.slice(0, at)).byteLength;
  return { id, type: "paragraph", start, end: start + TE.encode(sub).byteLength, heading: null };
}

function claim(overrides: Partial<CandidateClaim> & { quote: string; block: number }): CandidateClaim {
  return {
    kind: "result",
    statement: "s",
    task: null,
    metric: null,
    dataset: null,
    valueText: null,
    unit: null,
    conditions: null,
    ...overrides,
  };
}

describe("verifyClaims", () => {
  it("verifies exact bytes in the stated block", () => {
    const text = "Intro.\n\nThe residual mapping F(x) = H(x) \u2212 x is learned.\n";
    const sub = "The residual mapping F(x) = H(x) \u2212 x is learned.";
    const blocks = [blockFor(1, text, "Intro."), blockFor(2, text, sub)];
    const out = verifyClaims(text, blocks, [claim({ quote: sub, block: 2 })]);
    expect(out.dropped).toEqual([]);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]).toMatchObject({ block: 2, ambiguous: false });
    const found = out.claims[0];
    if (found !== undefined) {
      expect(sliceUtf8(text, found.start, found.end)).toBe(sub);
      expect(found.quote).toBe(sub);
    }
  });

  it("keeps multibyte boundaries byte-exact", () => {
    const text = "Start.\n\nCyrillic \u0442\u0435\u0441\u0442 \uD83C\uDF0D end.\n";
    const sub = "\u0442\u0435\u0441\u0442 \uD83C\uDF0D";
    const blocks = [blockFor(1, text, "Start."), blockFor(2, text, sub)];
    const out = verifyClaims(text, blocks, [claim({ quote: sub, block: 2 })]);
    expect(out.dropped).toEqual([]);
    const found = out.claims[0];
    if (found !== undefined) {
      expect(sliceUtf8(text, found.start, found.end)).toBe(sub);
      expect(found.end - found.start).toBe(TE.encode(sub).byteLength);
      expect(found.quote).toBe(sub);
    }
  });

  it("falls back to the immediate neighbour with the resolved block id", () => {
    const text = "First.\n\nAnswer 95.2% here.\n\nThird.\n";
    const sub = "Answer 95.2% here.";
    const blocks = [blockFor(1, text, "First."), blockFor(2, text, sub), blockFor(3, text, "Third.")];
    const out = verifyClaims(text, blocks, [claim({ quote: sub, block: 3 })]);
    expect(out.dropped).toEqual([]);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]).toMatchObject({ block: 2, ambiguous: false });
  });

  it("stores the canonical slice for normalized input, never the candidate string", () => {
    const text = "A.\n\nWell\u2013known \u201Cquoted\u201D well\u00ADknown.\n";
    const sub = "Well\u2013known \u201Cquoted\u201D well\u00ADknown.";
    const blocks = [blockFor(1, text, "A."), blockFor(2, text, sub)];
    const candidate = 'Well-known "quoted" wellknown.';
    const out = verifyClaims(text, blocks, [claim({ quote: candidate, block: 2 })]);
    expect(out.dropped).toEqual([]);
    expect(out.claims).toHaveLength(1);
    const found = out.claims[0];
    if (found !== undefined) {
      expect(found.quote).not.toBe(candidate);
      expect(found.quote).toBe(sub);
      expect(found.quote).toBe(sliceUtf8(text, found.start, found.end));
    }
  });

  it("marks duplicates ambiguous and keeps the stated occurrence", () => {
    const one = "Same sentence here.";
    const text = one + "\n\n" + one + "\n";
    const second = TE.encode(one + "\n\n").byteLength;
    const blocks: Block[] = [
      { id: 1, type: "paragraph", start: 0, end: TE.encode(one).byteLength, heading: null },
      { id: 2, type: "paragraph", start: second, end: second + TE.encode(one).byteLength, heading: null },
    ];
    const out = verifyClaims(text, blocks, [claim({ quote: one, block: 1 })]);
    expect(out.dropped).toEqual([]);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]).toMatchObject({ block: 1, ambiguous: true });
    const found = out.claims[0];
    if (found !== undefined) expect(sliceUtf8(text, found.start, found.end)).toBe(one);
  });

  it("drops empty quotes, unknown blocks and unmatched quotes", () => {
    const text = "Only text.\n";
    const blocks = [blockFor(1, text, "Only text.")];
    const out = verifyClaims(text, blocks, [
      claim({ quote: "   ", block: 1 }),
      claim({ quote: "Only text.", block: 9 }),
      claim({ quote: "Missing entirely.", block: 1 }),
    ]);
    expect(out.claims).toEqual([]);
    expect(out.dropped).toEqual([
      { index: 0, reason: "empty-quote" },
      { index: 1, reason: "unknown-block" },
      { index: 2, reason: "unmatched" },
    ]);
  });

  it("keeps numbers only when every digit group occurs whole in the quote", () => {
    const text = "Score.\n\nAccuracy reached 95.2% on test.\n";
    const sub = "Accuracy reached 95.2% on test.";
    const blocks = [blockFor(1, text, "Score."), blockFor(2, text, sub)];
    const kept = verifyClaims(text, blocks, [
      claim({ quote: sub, block: 2, valueText: "95.2%", unit: "%", conditions: "test split" }),
    ]);
    expect(kept.dropped).toEqual([]);
    expect(kept.clearedNumbers).toBe(0);
    expect(kept.claims[0]).toMatchObject({ valueText: "95.2%", valueNumber: 95.2, unit: "%", conditions: "test split" });
    const cleared = verifyClaims(text, blocks, [
      claim({ quote: sub, block: 2, valueText: "95.3%", unit: "%", conditions: "test split" }),
    ]);
    expect(cleared.dropped).toEqual([]);
    expect(cleared.clearedNumbers).toBe(1);
    expect(cleared.claims[0]).toMatchObject({ valueText: null, valueNumber: null, unit: null, conditions: "test split" });
  });

  it("rejects validation metadata contradicted by its own explicit test-set quote", () => {
    const quote = "Training error decreases. Evaluation error is 7.5% on the Dataset A test set.";
    const out = verifyClaims(quote, [blockFor(1, quote, quote)], [claim({
      quote, block: 1, statement: "Evaluation error is 7.5% on the Dataset A test set.",
      dataset: "Dataset A validation", metric: "error", valueText: "7.5", unit: "%",
    })]);
    expect(out.claims).toEqual([]);
    expect(out.dropped).toEqual([{ index: 0, reason: "contradictory-dataset-split" }]);
  });

  it("retains matching split metadata without rewriting the result or treating dev as a different split", () => {
    for (const [split, dataset] of [["test", "Corpus test"], ["validation", "Corpus dev"]] as const) {
      const quote = `Evaluation error is 7.5% on the Corpus ${split} set.`;
      const out = verifyClaims(quote, [blockFor(1, quote, quote)], [claim({
        quote, block: 1, statement: quote, dataset, metric: "error", valueText: "7.5", unit: "%",
      })]);
      expect(out.dropped).toEqual([]);
      expect(out.claims).toHaveLength(1);
      const stored = out.claims[0];
      if (!stored) throw new Error("The matching result must be retained.");
      expect(stored).toMatchObject({ dataset, statement: quote, quote, valueNumber: 7.5 });
      expect(resultStatement(stored)).toBe(quote);
    }
  });

  it("leaves ambiguous splits, absent split context and unknown dataset splits for semantic review", () => {
    for (const [quote, dataset] of [
      ["Error is 7.5% on Corpus training data and on the Corpus test set.", "Corpus validation"],
      ["Error is 7.5% on Corpus training and test data.", "Corpus validation"],
      ["A statistical test reports an error of 7.5% on Corpus.", "Corpus validation"],
      ["Error is 7.5% on the Corpus test set.", "Corpus unspecified"],
      ["Error is 7.5% on the Corpus test set.", "Corpus test/validation"],
    ] as const) {
      const out = verifyClaims(quote, [blockFor(1, quote, quote)], [claim({ quote, block: 1, statement: quote, dataset })]);
      expect(out.dropped).toEqual([]);
      expect(out.claims).toHaveLength(1);
    }
  });

  it("does not bind another dataset's test set to the candidate's validation result", () => {
    const quote = "Dataset A validation accuracy is 7.4. Dataset B uses a test set.";
    const statement = "Dataset A validation accuracy is 7.4.";
    const out = verifyClaims(quote, [blockFor(1, quote, quote)], [claim({
      quote, block: 1, statement, dataset: "Dataset A validation", metric: "accuracy", valueText: "7.4",
    })]);
    expect(out.dropped).toEqual([]);
    expect(out.claims).toHaveLength(1);
    const stored = out.claims[0];
    if (!stored) throw new Error("The unrelated dataset must not reject this result.");
    expect(stored).toMatchObject({ dataset: "Dataset A validation", statement, quote, valueNumber: 7.4 });
    expect(resultStatement(stored)).toBe(statement);
  });

  it("checks scalar numeric identity without requiring percent typography", () => {
    const quote = "Validation accuracy reached 50.";
    const statement = "Validation accuracy reached 50%.";
    const blocks = [blockFor(1, quote, quote)];
    const out = verifyClaims(quote, blocks, [
      claim({ quote, block: 1, statement, metric: "validation accuracy", valueText: "50", unit: "%" }),
    ]);
    expect(out.dropped).toEqual([]);
    expect(out.clearedNumbers).toBe(0);
    expect(out.claims).toHaveLength(1);
    const stored = out.claims[0];
    if (!stored) throw new Error("The numerically supported scalar must be retained.");
    expect(stored).toMatchObject({ quote, statement, valueText: "50", valueNumber: 50, unit: "%" });
    expect(resultStatement(stored)).toBe(statement);
    // Numeric presence alone grants no unit or condition entailment.
    expect(numbersSupported("with 50% dropout", "Count 50.")).toBe(true);
    expect(numbersSupported("with 50% dropout", "Training cost 0.50.")).toBe(false);
  });

  it("keeps a result whose percent unit is explicit in its own table header", () => {
    const quote = "| Method | Accuracy (%) |\n| --- | --- |\n| A | 50 |";
    const statement = "Method A has 50% accuracy.";
    const blocks = [{ ...blockFor(1, quote, quote), type: "table" as const }];
    const out = verifyClaims(quote, blocks, [
      claim({ quote, block: 1, statement, metric: "Accuracy", valueText: "50", unit: "%" }),
    ]);
    expect(out.dropped).toEqual([]);
    expect(out.claims).toHaveLength(1);
    const stored = out.claims[0];
    if (!stored) throw new Error("The same-quote table result must be retained.");
    expect(stored).toMatchObject({ quote, start: 0, end: TE.encode(quote).byteLength, valueText: "50", valueNumber: 50, unit: "%" });
    expect(resultStatement(stored)).toBe(statement);
  });

  it("rejects substring digit groups that are not whole runs", () => {
    const text = "Count.\n\nThere are 950 samples.\n";
    const sub = "There are 950 samples.";
    const blocks = [blockFor(1, text, "Count."), blockFor(2, text, sub)];
    const out = verifyClaims(text, blocks, [claim({ quote: sub, block: 2, valueText: "95", unit: null })]);
    expect(out.clearedNumbers).toBe(1);
    expect(out.claims[0]).toMatchObject({ valueText: null, valueNumber: null });
  });

  it("parses thousands and scientific notation, leaves ambiguous text unparsed", () => {
    const text = "Sizes.\n\nCorpus has 1,280,000 images and rate 1e-8.\n";
    const sub = "Corpus has 1,280,000 images and rate 1e-8.";
    const blocks = [blockFor(1, text, "Sizes."), blockFor(2, text, sub)];
    const out = verifyClaims(text, blocks, [
      claim({ quote: sub, block: 2, valueText: "1,280,000", unit: "images" }),
      claim({ quote: sub, block: 2, valueText: "1 280 000", unit: null }),
      claim({ quote: sub, block: 2, valueText: "1e-8", unit: null }),
    ]);
    expect(out.dropped).toEqual([]);
    expect(out.clearedNumbers).toBe(0);
    expect(out.claims[0]).toMatchObject({ valueText: "1,280,000", valueNumber: 1280000 });
    expect(out.claims[1]).toMatchObject({ valueText: "1 280 000", valueNumber: null });
    expect(out.claims[2]).toMatchObject({ valueText: "1e-8", valueNumber: 1e-8 });
  });

  it("drops statements whose numbers lack quote support, keeps supported model names", () => {
    const text = "Models.\n\nResNet-50 wins. Accuracy reached 95.2%.\n";
    const supported = "ResNet-50 wins. Accuracy reached 95.2%.";
    const blocks = [blockFor(1, text, "Models."), blockFor(2, text, supported)];
    const out = verifyClaims(text, blocks, [
      claim({ quote: supported, block: 2, statement: "ResNet-50 wins." }),
      claim({ quote: supported, block: 2, statement: "Accuracy reached 99.9%." }),
    ]);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]).toMatchObject({ statement: "ResNet-50 wins." });
    expect(out.dropped).toEqual([{ index: 1, reason: "unsupported-statement-numbers" }]);
    expect(out.clearedNumbers).toBe(0);
  });

  it("drops conditions that smuggle numbers absent from the quote", () => {
    const text = "Score.\n\nAccuracy reached 95.2% on test.\n";
    const sub = "Accuracy reached 95.2% on test.";
    const blocks = [blockFor(1, text, "Score."), blockFor(2, text, sub)];
    const out = verifyClaims(text, blocks, [
      claim({ quote: sub, block: 2, statement: "Accuracy reached 95.2%.", conditions: "trained for 3.5 days on 8 GPUs" }),
      claim({ quote: sub, block: 2, statement: "Accuracy reached 95.2%.", conditions: "test split, single run" }),
    ]);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]).toMatchObject({ conditions: "test split, single run" });
    expect(out.dropped).toEqual([{ index: 0, reason: "unsupported-condition-numbers" }]);
    expect(out.clearedNumbers).toBe(0);
  });

  it("rejects a percentage condition borrowed from another block or a decimal axis tick", () => {
    const cost = "Training cost reached 0.50.";
    const dropout = "Training used 50% dropout.";
    const text = cost + "\n\n" + dropout;
    const blocks = [blockFor(1, text, cost), blockFor(2, text, dropout)];
    const out = verifyClaims(text, blocks, [
      claim({ quote: cost, block: 1, statement: "Training cost decreased.", conditions: "with 50% dropout" }),
      claim({ quote: dropout, block: 2, statement: "Training used dropout.", conditions: "with 50% dropout" }),
    ]);
    expect(out.dropped).toEqual([{ index: 0, reason: "unsupported-condition-numbers" }]);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]).toMatchObject({ block: 2, quote: dropout, conditions: "with 50% dropout" });
  });

  it.each([
    ["−(50%)", "(50%)"],
    ["(50%)", "−(50%)"],
  ])("preserves a single-number parenthesized sign in statements and results: %s / %s", (value, sourceValue) => {
    const quote = "Reported change " + sourceValue + ".";
    const statement = "Reported change " + value + ".";
    const blocks = [blockFor(1, quote, quote)];
    const candidate = claim({ quote, block: 1, statement, valueText: value });
    const out = verifyClaims(quote, blocks, [candidate]);
    expect(out.claims).toEqual([]);
    expect(out.dropped).toEqual([{ index: 0, reason: "unsupported-statement-numbers" }]);
    expect(resultStatement({ ...candidate, start: 0, end: TE.encode(quote).byteLength, ambiguous: false, valueNumber: null })).toBeNull();

    const supported = verifyClaims(quote, blocks, [claim({ quote, block: 1, statement: quote, valueText: sourceValue })]);
    expect(supported.dropped).toEqual([]);
    expect(supported.claims).toHaveLength(1);
    const stored = supported.claims[0];
    if (!stored) throw new Error("Source-exact percentage result must be retained.");
    expect(resultStatement(stored)).toBe(quote);
    expect(numbersSupported("50%", quote)).toBe(sourceValue === "(50%)");
  });

  it("rejects 41.8 glued from a 41.0 passage plus a separate 8", () => {
    const passage =
      "Training took 3.5 days on 8 P100 GPUs.\n" +
      "On the WMT 2014 English-to-French translation task, our big model achieves a BLEU score of 41.0,\n" +
      "outperforming all of the previously published single models.";
    const text = "Intro.\n\n" + passage + "\n";
    const blocks = [blockFor(1, text, "Intro."), blockFor(2, text, passage)];
    const dropped = verifyClaims(text, blocks, [
      claim({ quote: passage, block: 2, statement: "Model achieves 41.8 BLEU on EN-FR." }),
    ]);
    expect(dropped.claims).toEqual([]);
    expect(dropped.dropped).toEqual([{ index: 0, reason: "unsupported-statement-numbers" }]);
    const cleared = verifyClaims(text, blocks, [
      claim({ quote: passage, block: 2, statement: "Note.", valueText: "41.8", unit: "BLEU" }),
    ]);
    expect(cleared.dropped).toEqual([]);
    expect(cleared.clearedNumbers).toBe(1);
    expect(cleared.claims[0]).toMatchObject({ valueText: null, valueNumber: null, unit: null });
  });
});

describe("numbersSupported", () => {
  it("rejects numeric prose absent from the exact evidence", () => {
    const quote = "Model X scores 28.4 BLEU on test.";
    expect(numbersSupported("Ran on 8 GPUs for 3.5 days.", quote)).toBe(false);
    expect(numbersSupported("Model X scores 28.4 BLEU.", quote)).toBe(true);
    expect(numbersSupported("No numbers here.", quote)).toBe(true);
  });

  it("requires whole dotted decimals, not glued groups", () => {
    expect(numbersSupported("Score 41.8 here.", "score 41.0 here and 8 there")).toBe(false);
    expect(numbersSupported("Score 41.8 here.", "score 41.8 here")).toBe(true);
    expect(numbersSupported("Score 41,8 here.", "score 41.0 here and 8 there")).toBe(false);
    expect(numbersSupported("Score 41,8 here.", "score 41.8 here")).toBe(true);
    expect(numbersSupported("Score 41.8 here.", "score 41.8e2 here")).toBe(false);
    expect(numbersSupported("Score 41.8e2 here.", "score 41.8 here and 2 there")).toBe(false);
    expect(numbersSupported("Score 79.9 here.", "score 79 here and 9 there")).toBe(false);
    expect(numbersSupported("Rate 1e-8 ok.", "rate 1e-8 ok")).toBe(true);
    expect(numbersSupported("Total 1,280,000 items.", "total 1,280,000 items")).toBe(true);
    expect(numbersSupported("10,000", "10,000dollars")).toBe(true);
  });

  it.each([
    ["50", "Training cost 0.50."],
    ["50", "Count 150."],
    ["50", "Scale 1e50."],
    ["8512", "Values 8 512."],
    ["10000", "10,000dollars"],
    ["with 50% dropout", "Training cost 0.50."],
    ["with 50% dropout", "Dropout 150%."],
    ["with 50% dropout", "Dropout 0.50%."],
    ["with 50% dropout", "Change -50%."],
    ["with 50% dropout", "Change 1e50%."],
    ["dropout50%", "Training cost 0.50."],
    ["−10^8%", "10^8%"],
  ])("rejects borrowed numeric literals: %s / %s", (text, quote) => {
    expect(numbersSupported(text, quote)).toBe(false);
  });

  it.each([
    ["50%", "Dropout 50%."],
    ["50 %", "Dropout 50\\%."],
    ["50\\,\\%", "Dropout 50\u00a0%."],
    ["50%", "Dropout 50\\,\\%."],
    ["50%", "Dropout 50\n%."],
    ["−5,2%", "Change -5.2 %."],
    ["+1E−2%", "Change +1e-2\\%."],
    ["7.6×10⁹%", "Change 7.6×10^9\\%."],
    ["−10^8%", "Change -10^8%."],
    ["`100%10`", "Observed `100%10`."],
    ["−10^{ 8}%", "Observed −10^{ 8}%."],
    [".50%", "Observed 0.50%."],
    ["50%", "Observed 50.0%."],
  ])("keeps complete and source-exact percentage formats: %s", (value, quote) => {
    expect(numbersSupported(value, quote)).toBe(true);
  });

  it("keeps the literal exponent sign on integer mantissas", () => {
    expect(numbersSupported("1e8", "1e-8")).toBe(false);
    expect(numbersSupported("1e-8", "1e-8")).toBe(true);
    expect(numbersSupported("1E8", "1e8")).toBe(true);
    expect(numbersSupported("1e−8", "1e-8")).toBe(true);
    expect(numbersSupported("1e8", "1e8")).toBe(true);
  });

  it("keeps explicit multiplication powers atomic across caret and superscript forms", () => {
    const superscript = "Computation is 7.6×10⁹.";
    expect(numbersSupported(superscript, "Values 7.6×10⁹.")).toBe(true);
    expect(numbersSupported(superscript, "Values 7.6×10^9.")).toBe(true);
    expect(numbersSupported("Computation is 7.6×10^9.", "Values 7.6×10⁹.")).toBe(true);
    expect(numbersSupported(superscript, "Values 7.6×10^8.")).toBe(false);
    expect(numbersSupported(superscript, "Values 7.6×109. A 10-layer model and 9 other entries.")).toBe(false);
    expect(numbersSupported(superscript, "Values 7.6. A 10-layer model and 9 other entries.")).toBe(false);
    expect(numbersSupported("Only 10 and 9.", "The value is 7.6×10^9.")).toBe(false);
    expect(numbersSupported("Operations are 31·10^6.", "Operations are 31·10⁶.")).toBe(true);
    expect(numbersSupported("Maximum accuracy after 6 times 10^6 training steps.", "Maximum accuracy after 6 · 106 training steps; 10% dropout.")).toBe(false);
    expect(numbersSupported("Maximum accuracy after 6 times 10^6 training steps.", "Maximum accuracy after 6 · 10⁶ training steps.")).toBe(true);
  });

  it("verifies a nonatomic guide hypothesis against the union of declared quotes only", () => {
    const sentence =
      "On closed-book question answering, GPT-3 achieves 64.3% zero-shot, 68.0% one-shot, and 71.2% few-shot accuracy on TriviaQA, with the zero-shot result already outperforming fine-tuned T5-11B by 14.2%. [S1:25] [S1:68]";
    const labels = ["[S1:25]", "[S1:68]"];
    const rev = "b60124f8-bf0a-496a-b53f-f9464db7564b";
    const cleaned = cleanDistillText(sentence, labels, rev);
    expect(cleaned.invalidReferences).toBe(0);
    const quote25 =
      "Though the results in this case are particularly striking, the general trends with both model size and\nnumber of examples in-context hold for most tasks we study. We emphasize that these \u201clearning\u201d curves involve no\ngradient updates or fine-tuning, just increasing numbers of demonstrations given as conditioning.\nBroadly, on NLP tasks GPT-3 achieves promising results in the zero-shot and one-shot settings, and in the the few-shot\nsetting is sometimes competitive with or even occasionally surpasses state-of-the-art (despite state-of-the-art being held\nby fine-tuned models). For example, GPT-3 achieves 81.5 F1 on CoQA in the zero-shot setting, 84.0 F1 on CoQA in\nthe one-shot setting, 85.0 F1 in the few-shot setting. Similarly, GPT-3 achieves 64.3% accuracy on TriviaQA in the\nzero-shot setting, 68.0% in the one-shot setting, and 71.2% in the few-shot setting, the last of which is state-of-the-art\nrelative to fine-tuned models operating in the same closed-book setting.\n";
    const quote68 =
      "Note that in addition to all results being in\nthe closed-book setting, our use of few-shot, one-shot, and zero-shot evaluations represent an even stricter setting than\nprevious closed-book QA work: in addition to external content not being allowed, fine-tuning on the Q&A dataset itself\nis also not permitted.\nThe results for GPT-3 are shown in Table 3.3. On TriviaQA, we achieve 64.3% in the zero-shot setting, 68.0% in the\none-shot setting, and 71.2% in the few-shot setting. The zero-shot result already outperforms the fine-tuned T5-11B by\n14.2%, and also outperforms a version with Q&A tailored span prediction during pre-training by 3.8%. The one-shot\nresult improves by 3.7% and matches the SOTA for an open-domain QA system which not only fine-tunes but also\nmakes use of a learned retrieval mechanism over a 15.3B parameter dense vector index of 21M documents [LPP+20].\nGPT-3\u2019s few-shot result further improves performance another 3.2% beyond this.\n";
    expect(numbersSupported(cleaned.text, quote25)).toBe(false);
    expect(numbersSupported(cleaned.text, quote25 + "\n" + quote68)).toBe(true);
  });
});

describe("sourceContextJson", () => {
  it("round-trips UTF-8, quotes, backslashes and technical literal brackets", () => {
    const input = {
      quoteBlock: "[S1:7]",
      text: 'Кириллица 🌍: "quoted" C:\\docs\\[note]\n[MASK] and literal \\u005b.',
    };
    const projected = sourceContextJson(input, new Set(["[S1:7]"]));
    expect(JSON.parse(projected)).toEqual(input);
    expect(projected).toContain('"quoteBlock":"[S1:7]"');
    expect(projected).toContain("Кириллица 🌍");
    expect(projected).toContain("\\u005bMASK\\u005d");
    expect(projected).not.toContain("[MASK]");
  });

  it("keeps structural arrays and exact authority strings while escaping bracketed prose", () => {
    const persistent = "[R123e4567-e89b-12d3-a456-426614174000:7]";
    const input = {
      evidence: [{ label: "[S1:7]", block: 7, quote: "Array [1, 2] and tensor [n, d]." }],
      guideCandidates: [{ labels: ["[S1:7]", persistent], text: "Embedded [S1:7] and undeclared [S1:70]." }],
      candidates: [{ id: "C0", quoteBlock: "[S1:7]", statement: "A literal [value] is retained." }],
    };
    const projected = sourceContextJson(input, new Set(["[S1:7]", persistent]));
    expect(JSON.parse(projected)).toEqual(input);
    expect(projected).toContain('"evidence":[{');
    expect(projected).toContain('"labels":["[S1:7]","' + persistent + '"]');
    expect(projected).toContain("Embedded \\u005bS1:7\\u005d");
    expect(projected).toContain("undeclared \\u005bS1:70\\u005d");
    expect(projected).toContain("Array \\u005b1, 2\\u005d");
  });
});

describe("resolveQuoteBlock", () => {
  it("returns exact canonical bytes for an S1 label, keeping hard hyphens and brackets", () => {
    const text = "Intro.\n\nThe state-\nof-the-art [MASK] model.\n";
    const target = "The state-\nof-the-art [MASK] model.";
    const blocks = [blockFor(1, text, "Intro."), blockFor(2, text, target)];
    const resolved = resolveQuoteBlock(text, blocks, "[S1:2]");
    expect(resolved).toEqual({ block: 2, quote: target });
    if (resolved !== undefined) expect(sliceUtf8(text, blocks[1]?.start ?? -1, blocks[1]?.end ?? -1)).toBe(resolved.quote);
  });

  it("rejects out-of-scope aliases and malformed labels without searching", () => {
    const text = "First.\n\nSecond.\n";
    const blocks = [blockFor(1, text, "First."), blockFor(2, text, "Second.")];
    expect(resolveQuoteBlock(text, blocks, "[S2:2]")).toBeUndefined();
    expect(resolveQuoteBlock(text, blocks, "[S1:9]")).toBeUndefined();
    expect(resolveQuoteBlock(text, blocks, "[S0:1]")).toBeUndefined();
    expect(resolveQuoteBlock(text, blocks, "S1:1")).toBeUndefined();
    expect(resolveQuoteBlock(text, blocks, "[S1:x]")).toBeUndefined();
    expect(resolveQuoteBlock(text, blocks, "[R123e4567-e89b-12d3-a456-426614174000:1]")).toBeUndefined();
    expect(resolveQuoteBlock(text, blocks, "")).toBeUndefined();
    const broken: Block = { ...blockFor(1, text, "First."), start: 5, end: 2 };
    expect(resolveQuoteBlock(text, [broken], "[S1:1]")).toBeUndefined();
  });
});

describe("cleanDistillText", () => {
  it("strips declared markers but leaves factual numbers for the guard", () => {
    const text = "Trained on 8 GPUs [S1:7] for 3.5 days, see [Rrev-1:7] and [block 7].\n```\n[S1:7] [MASK]\n```\nMask stays [MASK].";
    const cleaned = cleanDistillText(text, ["[S1:7]"], "rev-1");
    expect(cleaned.invalidReferences).toBe(0);
    expect(cleaned.text).toBe("Trained on 8 GPUs  for 3.5 days, see  and .\n```\n[S1:7] [MASK]\n```\nMask stays [MASK].");
    expect(numbersSupported(cleaned.text, "Model X.")).toBe(false);
  });

  it("counts unknown references without erasing them", () => {
    const out = cleanDistillText("See [S9:1] and [block 99] and [S1:] end.", ["[S1:7]"], "rev-1");
    expect(out.invalidReferences).toBe(3);
    expect(out.text).toBe("See [S9:1] and [block 99] and [S1:] end.");
  });

  it("keeps inline code literal while cleaning prose around it", () => {
    const text = "See [S1:7] and `[S1:7]` with 3.5.";
    const cleaned = cleanDistillText(text, ["[S1:7]"], "rev-1");
    expect(cleaned.invalidReferences).toBe(0);
    expect(cleaned.text).toBe("See  and `[S1:7]` with 3.5.");
    expect(numbersSupported(cleaned.text, "Model X.")).toBe(false);
  });

  it("preserves recognized anchors as persistent labels instead of dangling block prose", () => {
    const rev = "123e4567-e89b-12d3-a456-426614174000";
    const text = "Confirmed by block [S1:37]. See `[S1:37]` and [S9:1].";
    const stripped = cleanDistillText(text, ["[S1:37]"], rev);
    expect(stripped.invalidReferences).toBe(1);
    expect(stripped.text).toBe("Confirmed by block . See `[S1:37]` and [S9:1].");
    const kept = cleanDistillText(text, ["[S1:37]"], rev, true);
    expect(kept.invalidReferences).toBe(1);
    expect(kept.text).toBe("Confirmed by block [R" + rev + ":37]. See `[S1:37]` and [S9:1].");
  });
});

describe("splitDistillStatements", () => {
  it("keeps inline code literal while splitting prose around it", () => {
    const text = "First claim here. Second claim `[S1:7]` stays.\n```\n[S1:7] fenced\n```\nTail 3.5 end.";
    expect(splitDistillStatements(text)).toEqual([
      "First claim here.",
      "Second claim `[S1:7]` stays.",
      "```\n[S1:7] fenced\n```\n",
      "Tail 3.5 end.",
    ]);
  });

  it("keeps real BN notation intact while the guard separates supported from smuggled numbers", () => {
    const paragraph =
      "Experiments on ImageNet (Inception): Inception reached 72.2% after 31\u00B710^6 steps; " +
      "a 5\u00D7 learning-rate increase (0.0075) without BN caused parameters to reach machine infinity. " +
      "BN-Baseline matched Inception in less than half the steps; BN-x5 needed 14\u00D7 fewer steps for 72.2%; " +
      "BN-x30 (lr 0.045) reached 74.8% after 6\u00B710^6 steps (5\u00D7 fewer than Inception); " +
      "BN-x5-Sigmoid reached 69.8%, while sigmoid Inception without BN achieved at best 1/1000 accuracy. " +
      "With BN, Dropout can be removed or reduced, and much higher learning rates and less careful initialization become possible.";
    const units = splitDistillStatements(paragraph);
    expect(units).toEqual([
      "Experiments on ImageNet (Inception): Inception reached 72.2% after 31\u00B710^6 steps; a 5\u00D7 learning-rate increase (0.0075) without BN caused parameters to reach machine infinity.",
      "BN-Baseline matched Inception in less than half the steps; BN-x5 needed 14\u00D7 fewer steps for 72.2%; BN-x30 (lr 0.045) reached 74.8% after 6\u00B710^6 steps (5\u00D7 fewer than Inception); BN-x5-Sigmoid reached 69.8%, while sigmoid Inception without BN achieved at best 1/1000 accuracy.",
      "With BN, Dropout can be removed or reduced, and much higher learning rates and less careful initialization become possible.",
    ]);
    const quote = "BN-x5 needs 14 times fewer steps than In-\nception to reach the 72.2% accuracy.";
    expect(numbersSupported("BN-x5 needs 14 times fewer steps to reach 72.2%.", quote)).toBe(true);
    expect(numbersSupported("Inception reached 72.2% after 31\u00B710^6 steps.", quote)).toBe(false);
    expect(numbersSupported("Ioffe & Szegedy (Google, arXiv:1502.03167v3) propose Batch Normalization.", quote)).toBe(false);
  });
});

describe("resultStatement", () => {
  const syntheticQuote =
    "System Alpha reports 82.6% in setting A, 84.1% in setting B, and 86.3% in setting C.\n" +
    "Setting A is 3.4% above its prior score; an alternate method adds 1.7%.\n" +
    "The evaluated index contains 2.6 billion parameters and 4 million records.\n";
  const syntheticClaim: VerifiedClaim = {
    kind: "result",
    statement:
      "On Dataset A, System Alpha reports 82.6% in setting A, 84.1% in setting B, and 86.3% in setting C; setting A is 3.4% above its prior score.",
    quote: syntheticQuote,
    block: 1,
    task: "classification",
    metric: "accuracy",
    dataset: "Dataset A",
    valueText: "86.3",
    unit: "%",
    conditions: "setting C",
    start: 0,
    end: TE.encode(syntheticQuote).byteLength,
    ambiguous: false,
    valueNumber: 86.3,
  };

  it("rejects a compound result instead of collapsing it", () => {
    expect(resultStatement(syntheticClaim)).toBeNull();
  });

  it("rejects a result without valueText", () => {
    expect(resultStatement({ ...syntheticClaim, valueText: null })).toBeNull();
    expect(resultStatement({ ...syntheticClaim, valueText: "  " })).toBeNull();
  });

  it("allows an unparsed valueNumber but requires a finite one when given", () => {
    const atomic = {
      ...syntheticClaim,
      statement: "Accuracy reaches 86.3% in setting C.",
      task: "classification",
      metric: "accuracy",
      dataset: "Dataset A",
      conditions: "setting C",
      valueText: "86.3",
      unit: "%",
    };
    expect(resultStatement({ ...atomic, valueNumber: null })).toBe(atomic.statement);
    expect(resultStatement({ ...atomic, valueNumber: NaN })).toBeNull();
  });

  it("rejects an unsupported primary value", () => {
    expect(resultStatement({ ...syntheticClaim, valueText: "99.9", valueNumber: 99.9 })).toBeNull();
  });

  it("passes non-result statements through untouched", () => {
    const limitation: VerifiedClaim = {
      kind: "limitation",
      statement: "System Alpha can produce inconsistent summaries for some inputs.",
      quote: "System Alpha can produce inconsistent summaries for some inputs.",
      block: 1,
      task: null,
      metric: null,
      dataset: null,
      valueText: null,
      unit: null,
      conditions: null,
      start: 0,
      end: TE.encode("System Alpha can produce inconsistent summaries for some inputs.").byteLength,
      ambiguous: false,
      valueNumber: null,
    };
    expect(resultStatement(limitation)).toBe(limitation.statement);
  });

  it("does not double a percent unit already on the value", () => {
    const percent: VerifiedClaim = {
      ...syntheticClaim,
      statement: "System Alpha reaches 63.5% accuracy on the test set.",
      quote: "System Alpha reaches 63.5% accuracy on the test set.",
      task: null,
      dataset: null,
      conditions: null,
      valueText: "63.5%",
      unit: "%",
      valueNumber: 63.5,
    };
    expect(resultStatement(percent)).toBe(percent.statement);
  });
  it("rejects a synthetic two-scalar list instead of splitting it", () => {
    const compoundQuote = "System Alpha\u2019s classifier reached\n+12.7% on setting A and 5.4%\non setting B.";
    expect(
      resultStatement({
        ...syntheticClaim,
        task: "classification",
        metric: "accuracy",
        dataset: "Dataset B",
        conditions: null,
        quote: compoundQuote,
        statement: "System Alpha\u2019s classifier reached +12.7% on setting A and 5.4% on setting B.",
        valueText: "+12.7% / 5.4%",
        unit: "%",
        valueNumber: null,
      }),
    ).toBeNull();
  });
  it("keeps one scientific quantity and one scalar with unit", () => {
    const base = { ...syntheticClaim, task: null, dataset: null, conditions: null };
    expect(
      resultStatement({ ...base, statement: "rate 6e-7", metric: "rate", quote: "Corpus rate 6e-7.", valueText: "6e-7", unit: null, valueNumber: 6e-7 }),
    ).toBe("rate 6e-7");
    expect(
      resultStatement({ ...base, statement: "decay 3.6\u00d710^\u22124", metric: "decay", quote: "Decay 3.6\u00d710^\u22124 rate.", valueText: "3.6\u00d710^\u22124", unit: null, valueNumber: null }),
    ).toBe("decay 3.6\u00d710^\u22124");
    expect(
      resultStatement({ ...base, statement: "steps 5\u00d7", metric: "steps", quote: "Needs 5\u00d7 fewer steps.", valueText: "5\u00d7", unit: "\u00d7", valueNumber: null }),
    ).toBe("steps 5\u00d7");
    expect(
      resultStatement({ ...base, statement: "epsilon 10^-7", metric: "epsilon", quote: "Optimizer epsilon 10^-7.", valueText: "10^-7", unit: null, valueNumber: null }),
    ).toBe("epsilon 10^-7");
  });
  it("passes a non-result qual fact even with compound numbers", () => {
    expect(
      resultStatement({ ...syntheticClaim, kind: "other", statement: "Qualitative note about training.", valueText: "+12.7% / 5.4%", unit: "%", valueNumber: null }),
    ).toBe("Qualitative note about training.");
  });
  it("preserves the 4.6% absolute improvement with its qualifier", () => {
    const statement = "System Alpha obtains a 4.6% absolute improvement in validation accuracy.";
    const quote = "System Alpha obtains a 4.6% absolute\nimprovement in validation accuracy.";
    expect(
      resultStatement({ ...syntheticClaim, task: "classification", metric: "accuracy", dataset: "Dataset B", conditions: null, quote, statement, valueText: "4.6%", unit: "%", valueNumber: 4.6 }),
    ).toBe(statement);
  });
  it("rejects the 1M versus 500k step conditions instead of erasing them", () => {
    const statement = "System Alpha reaches 1.0% additional accuracy on Dataset A when trained on 1M steps compared to 500k steps.";
    const quote = "System Alpha reaches 1.0% additional accuracy on Dataset A\nwhen trained on 1M steps compared to 500k steps.\n";
    expect(
      resultStatement({ ...syntheticClaim, task: "classification", metric: "accuracy", dataset: "Dataset A", conditions: null, quote, statement, valueText: "1.0%", unit: "%", valueNumber: 1 }),
    ).toBeNull();
  });
  it("rejects a synthetic 80/10/10 masking mix instead of collapsing to 84.2", () => {
    const statement = "System Alpha reaches 84.2% accuracy on Dataset A using an 80/10/10 masking mix.";
    const quote = "System Alpha reaches 84.2% accuracy on Dataset A using 80% masked, 10% unchanged, and 10% random input tokens.\n";
    expect(
      resultStatement({ ...syntheticClaim, task: "classification", metric: "accuracy", dataset: "Dataset A", conditions: null, quote, statement, valueText: "84.2", unit: "%", valueNumber: 84.2 }),
    ).toBeNull();
  });
});

describe("multi-block association limits", () => {
  const text =
    "Model Alpha achieves 91.2 F1 on the held-out test set.\n\nModel Beta achieves 86.4 F1 on the held-out test set.\n";
  const quoteA = "Model Alpha achieves 91.2 F1 on the held-out test set.";
  const quoteB = "Model Beta achieves 86.4 F1 on the held-out test set.";
  const blocks = [blockFor(1, text, quoteA), blockFor(2, text, quoteB)];
  const crossed: CandidateClaim = {
    kind: "result",
    statement: "Model Alpha achieves 86.4 F1 on the held-out test set.",
    quote: quoteA,
    block: 1,
    task: "Classification",
    metric: "F1",
    dataset: "Test",
    valueText: "86.4",
    unit: "F1",
    conditions: "Model Alpha",
  };

  it("rejects a claim against its own quote when the number lives in another block", () => {
    const result = verifyClaims(text, blocks, [crossed]);
    expect(result.claims).toEqual([]);
    expect(result.dropped).toEqual([{ index: 0, reason: "unsupported-statement-numbers" }]);
  });

  it("shows union-level numbers alone cannot attribute a value to a name", () => {
    expect(numbersSupported(crossed.statement, quoteA + "\n" + quoteB)).toBe(true);
    expect(numbersSupported(crossed.statement, quoteB)).toBe(true);
  });
});
