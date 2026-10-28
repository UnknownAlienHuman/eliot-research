import { describe, expect, it } from "vitest";
import type { Citation } from "./citations.js";
import type { ComparisonClaim } from "./comparisons.js";
import type { WikiEvidence } from "./knowledge.js";
import { projectComparisonResults } from "./comparison-evidence.js";
import type { SourceResultCandidate } from "./comparison-evidence.js";

type ProjectedComparisonClaim = ComparisonClaim & {
  readonly evaluationConditions?: string;
  readonly protocolCitations?: Citation[];
};

function evidence(
  sourceId: string,
  revisionId: string,
  block: number,
  quote: string,
  start: number,
  end: number,
): WikiEvidence {
  const citation: Citation = {
    sourceId,
    revisionId,
    block,
    start,
    end,
    sourceTitle: `Paper ${sourceId}`,
    deleted: false,
    label: `[R${revisionId}:${block}]`,
  };
  return { quote, citation };
}

function candidate(overrides: Partial<SourceResultCandidate> = {}): SourceResultCandidate {
  return {
    role: "own",
    label: "[Rrevision-bert:3]",
    protocolLabels: ["[Rrevision-bert:4]"],
    method: "BERT-Large",
    task: "GLUE",
    metric: "accuracy",
    dataset: "GLUE benchmark",
    valueText: "94.9",
    unit: "%",
    conditions: "training compute 1.9e20 FLOPs",
    evaluationConditions: "9 GLUE tasks on the test split",
    ...overrides,
  };
}

function tableEvidence(): WikiEvidence[] {
  return [
    evidence("source-bert", "revision-bert", 3, "BERT-Large | GLUE | 94.9", 120, 145),
    evidence("source-bert", "revision-bert", 4, "Training compute 1.9e20 FLOPs; evaluation used 9 GLUE tasks.", 145, 208),
    evidence("source-electra", "revision-electra", 8, "ELECTRA-1.75M | GLUE | 96.7", 840, 871),
    evidence("source-electra", "revision-electra", 9, "Training compute 3.1e21 FLOPs; evaluation used 9 GLUE tasks.", 871, 934),
  ];
}

describe("projectComparisonResults", () => {
  it("projects table-like 94.9 and 96.7 results with source-local protocol evidence", () => {
    const evidenceRows = tableEvidence();
    const results = projectComparisonResults([
      candidate({
        protocolLabels: ["[Rrevision-bert:3]", "[Rrevision-bert:4]"],
      }),
      candidate({
        label: "[Rrevision-electra:8]",
        protocolLabels: ["[Rrevision-electra:9]"],
        method: "ELECTRA-1.75M",
        valueText: "96.7",
        conditions: "training compute 3.1e21 FLOPs",
      }),
    ], evidenceRows) as ProjectedComparisonClaim[];

    expect(results).toHaveLength(2);
    expect(results.map((item) => item.valueText)).toEqual(["94.9", "96.7"]);
    expect(results[0]?.statement).toBe("BERT-Large — accuracy: 94.9");
    expect(results[0]?.task).toBe("GLUE");
    expect(results[0]?.dataset).toBe("GLUE benchmark");
    expect(results[0]?.conditions).toBe("training compute 1.9e20 FLOPs");
    expect(results[0]?.evaluationConditions).toBe("9 GLUE tasks on the test split");
    expect(results[0]?.quote).toBe(evidenceRows[0]?.quote);
    expect(results[0]?.sourceId).toBe("source-bert");
    expect(results[0]?.revisionId).toBe("revision-bert");
    expect(results[0]?.protocolCitations?.map((item) => item.label)).toEqual(["[Rrevision-bert:4]"]);
  });

  it("rejects a valueText containing more than one scalar", () => {
    const row = evidence("source-bert", "revision-bert", 3, "BERT-Large | 94.9 | 96.7", 120, 152);
    const protocol = evidence("source-bert", "revision-bert", 4, "Training compute 1.9e20 FLOPs; evaluation used 9 GLUE tasks.", 152, 215);
    expect(projectComparisonResults([
      candidate({ valueText: "94.9 / 96.7" }),
    ], [row, protocol])).toEqual([]);
  });

  it("rejects protocol evidence from another source even when its label resolves", () => {
    const row = evidence("source-bert", "revision-bert", 3, "BERT-Large | GLUE | 94.9", 120, 145);
    const foreignProtocol = evidence("source-electra", "revision-electra", 4, "Training compute 1.9e20 FLOPs; evaluation used 9 GLUE tasks.", 145, 208);
    expect(projectComparisonResults([candidate()], [row, foreignProtocol])).toEqual([]);
  });

  it("skips missing value labels and unknown protocol labels", () => {
    const row = evidence("source-bert", "revision-bert", 3, "BERT-Large | GLUE | 94.9", 120, 145);
    const protocol = evidence("source-bert", "revision-bert", 4, "Training compute 1.9e20 FLOPs; evaluation used 9 GLUE tasks.", 145, 208);
    expect(projectComparisonResults([candidate({ label: "[Rrevision-bert:99]" })], [row, protocol])).toEqual([]);
    expect(projectComparisonResults([candidate({ protocolLabels: ["[Rrevision-bert:99]"] })], [row, protocol])).toEqual([]);
  });

  it("preserves the trusted value quote and original citation range", () => {
    const row = evidence("source-bert", "revision-bert", 17, "BERT-Large | GLUE | 94.9", 4096, 4121);
    const protocol = evidence("source-bert", "revision-bert", 18, "Training compute 1.9e20 FLOPs; evaluation used 9 GLUE tasks.", 5000, 5063);
    const result = projectComparisonResults([
      candidate({ label: row.citation.label, protocolLabels: [protocol.citation.label] }),
    ], [row, protocol])[0];

    expect(result).toMatchObject({
      sourceId: "source-bert",
      revisionId: "revision-bert",
      quote: row.quote,
      block: 17,
      start: 4096,
      end: 4121,
    });
  });

  it("excludes baseline reprints and deduplicates repeated own results", () => {
    const row = evidence("source-bert", "revision-bert", 3, "BERT-Large | GLUE | 94.9", 120, 145);
    const protocol = evidence("source-bert", "revision-bert", 4, "Training compute 1.9e20 FLOPs; evaluation used 9 GLUE tasks.", 145, 208);
    const own = candidate();
    expect(projectComparisonResults([
      { ...own, role: "baseline" },
      own,
      own,
    ], [row, protocol])).toHaveLength(1);
  });

  it("rejects citation tokens embedded in descriptive metadata", () => {
    const row = evidence("source-bert", "revision-bert", 3, "BERT-Large | GLUE | 94.9", 120, 145);
    const protocol = evidence("source-bert", "revision-bert", 4, "Training compute 1.9e20 FLOPs; evaluation used 9 GLUE tasks.", 145, 208);
    expect(projectComparisonResults([
      candidate({ conditions: "training [Rrevision-bert:4]" }),
    ], [row, protocol])).toEqual([]);
  });
});
