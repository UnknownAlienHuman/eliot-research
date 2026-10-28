import { describe, expect, it } from "vitest";
import type { WikiEvidence } from "./knowledge";
import { checkWikiOutput, wikiSchema, type WikiOutput } from "./wiki";

function evidence(sourceId: string, revisionId: string, block: number, quote: string, sourceTitle: string): WikiEvidence {
  return {
    quote,
    citation: {
      sourceId,
      revisionId,
      block,
      start: block * 10,
      end: block * 10 + 100,
      sourceTitle,
      deleted: false,
      label: `[R${revisionId}:${block}]`,
    },
  };
}

const bn = evidence(
  "source-bn",
  "revision-bn",
  4,
  "Batch Normalization reduces internal covariate shift in deep neural networks.",
  "Batch Normalization",
);
const resnet = evidence(
  "source-resnet",
  "revision-resnet",
  7,
  "Residual connections make it possible to train substantially deeper networks.",
  "Deep Residual Learning",
);

describe("wikiSchema", () => {
  it("declares labels before text and permits only frozen evidence labels", () => {
    const schema = wikiSchema([bn, resnet]);
    expect(schema.safeParse({ sections: [{ labels: [bn.citation.label], text: "Batch Normalization reduces internal covariate shift." }] }).success).toBe(true);
    expect(schema.safeParse({ sections: [{ labels: ["[Rforeign:1]"], text: "A factual sentence." }] }).success).toBe(false);
    expect(schema.safeParse({ sections: [{ labels: [bn.citation.label], text: "x".repeat(1500) }] }).success).toBe(true);
    expect(schema.safeParse({ sections: [{ labels: [bn.citation.label], text: "x".repeat(1501) }] }).success).toBe(false);
    expect(schema.safeParse({ sections: Array.from({ length: 25 }, () => ({ labels: [bn.citation.label], text: "A factual sentence." })) }).success).toBe(false);
  });
});

describe("checkWikiOutput", () => {
  it("keeps a plain fact verbatim with its original citation", () => {
    const output: WikiOutput = { sections: [{ labels: [bn.citation.label], text: "Batch Normalization reduces internal covariate shift." }] };
    const result = checkWikiOutput(output, [bn], ["source-bn"]);
    expect(result).toEqual({
      body: "Batch Normalization reduces internal covariate shift.\n\n[Rrevision-bn:4]",
      citations: [bn.citation],
      kept: 1,
      dropped: [],
      missingSourceIds: [],
    });
  });

  it("drops an item with an inline revision citation instead of moving or rewriting it", () => {
    const output: WikiOutput = { sections: [{ labels: [bn.citation.label], text: "Batch Normalization helps [Rrevision-bn:4]." }] };
    const result = checkWikiOutput(output, [bn], ["source-bn"]);
    expect(result.kept).toBe(0);
    expect(result.body).toBe("");
    expect(result.citations).toEqual([]);
    expect(result.dropped).toEqual([{ index: 0, reason: "inline-citation-label" }]);
    expect(result.missingSourceIds).toEqual(["source-bn"]);
  });

  it("drops 'times 10^6' when the source spells the digits as 6 · 106", () => {
    const evidenceWithPower = evidence("source-resnet", "revision-resnet", 9, "The run used 6 · 106 steps.", "Deep Residual Learning");
    const output: WikiOutput = { sections: [{ labels: [evidenceWithPower.citation.label], text: "The run used 6 times 10^6 steps." }] };
    const result = checkWikiOutput(output, [evidenceWithPower], ["source-resnet"]);
    expect(result.kept).toBe(0);
    expect(result.dropped).toEqual([{ index: 0, reason: "unsupported-numeric-facts" }]);
    expect(result.citations).toEqual([]);
    expect(result.missingSourceIds).toEqual(["source-resnet"]);
  });

  it("reports a missing expected ResNet source when only Batch Normalization is cited", () => {
    const output: WikiOutput = { sections: [{ labels: [bn.citation.label], text: "Batch Normalization reduces internal covariate shift." }] };
    const result = checkWikiOutput(output, [bn, resnet], ["source-bn", "source-resnet"]);
    expect(result.kept).toBe(1);
    expect(result.citations).toEqual([bn.citation]);
    expect(result.dropped).toEqual([]);
    expect(result.missingSourceIds).toEqual(["source-resnet"]);
  });

  it("returns zero kept items when every item is invalid and never clips overlong text", () => {
    const output: WikiOutput = { sections: [
      { labels: [bn.citation.label], text: "# Unsupported heading" },
      { labels: [bn.citation.label], text: "Batch Normalization [Rrevision-bn:4]." },
      { labels: [resnet.citation.label], text: "The run used 6 times 10^6 steps." },
      { labels: [bn.citation.label], text: "x".repeat(1501) },
    ] };
    const result = checkWikiOutput(output, [bn, resnet], ["source-bn", "source-resnet"]);
    expect(result).toEqual({
      body: "",
      citations: [],
      kept: 0,
      dropped: [
        { index: 0, reason: "heading-or-multiline-text" },
        { index: 1, reason: "inline-citation-label" },
        { index: 2, reason: "unsupported-numeric-facts" },
        { index: 3, reason: "text-too-long" },
      ],
      missingSourceIds: ["source-bn", "source-resnet"],
    });
  });

  it("does not clip beyond the current 24-item bound", () => {
    const output: WikiOutput = { sections: Array.from({ length: 25 }, (_, index) => ({
      labels: [bn.citation.label],
      text: "Supported factual statement " + String.fromCharCode(65 + (index % 26)) + ".",
    })) };
    const result = checkWikiOutput(output, [bn], ["source-bn"]);
    expect(result.kept).toBe(24);
    expect(result.dropped).toEqual([{ index: 24, reason: "too-many-sections" }]);
    expect(result.body).toContain("Supported factual statement X.");
    expect(result.body).not.toContain("Supported factual statement Y.");
    expect(result.missingSourceIds).toEqual([]);
  });
});
