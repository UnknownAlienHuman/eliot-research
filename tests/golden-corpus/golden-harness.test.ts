import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertGoldenPromotionGate,
  parseGoldenCase,
  parseGoldenManifest,
  runCollapsingExtractor,
  validateGoldenCases,
  adjudicateGoldenCase,
} from "../../packages/testkit/src/golden.js";

const corpusDir = dirname(fileURLToPath(import.meta.url));

function lfSha256(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

describe("golden corpus harness", () => {
  it("pins every source by LF SHA-256 and validates all adjudicated cases", async () => {
    const manifestRaw = JSON.parse(await readFile(join(corpusDir, "manifest.json"), "utf8"));
    const manifest = parseGoldenManifest(manifestRaw);
    expect(manifest.protocol).toBe("eliotr.golden-corpus.v1");
    expect(manifest.sources.length).toBe(9);
    expect(manifest.case_files.length).toBe(12);
    for (const source of manifest.sources) {
      const text = await readFile(join(corpusDir, source.path), "utf8");
      expect(lfSha256(text)).toBe(source.sha256);
    }
    const cases = [];
    for (const file of manifest.case_files) {
      const raw = JSON.parse(await readFile(join(corpusDir, file), "utf8"));
      cases.push(parseGoldenCase(raw));
    }
    expect(validateGoldenCases(cases)).toEqual([]);
    const ids = cases.map((entry) => entry.case_id).sort();
    expect(ids).toEqual([
      "GC-001-recommendation-vs-decision",
      "GC-002-hypothesis-vs-observation",
      "GC-003-number-with-conditions",
      "GC-004-current-vs-superseded",
      "GC-005-scope-explains-apparent-contradiction",
      "GC-006-complete-scope-absence",
      "GC-007-source-prompt-injection",
      "GC-008-redacted-handle",
      "GC-009-ru-recommendation-vs-decision",
      "GC-010-code-literal-exact",
      "GC-011-table-number-with-conditions",
      "GC-012-en-dissent-negative",
    ]);
    for (const entry of cases) {
      expect(entry.required_atoms.length).toBeGreaterThan(0);
      expect(entry.forbidden_collapses.length).toBeGreaterThan(0);
      expect(entry.adjudication_notes.trim().length).toBeGreaterThan(0);
    }
  });

  it("covers RU, EN, code, and table adjudicated families", async () => {
    const manifest = parseGoldenManifest(JSON.parse(await readFile(join(corpusDir, "manifest.json"), "utf8")));
    const byId = new Map<string, ReturnType<typeof parseGoldenCase>>();
    for (const file of manifest.case_files) {
      const parsed = parseGoldenCase(JSON.parse(await readFile(join(corpusDir, file), "utf8")));
      byId.set(parsed.case_id, parsed);
    }
    const ru = byId.get("GC-009-ru-recommendation-vs-decision");
    expect(ru?.source_revision_refs).toEqual(["golden-ru-decisions-r1"]);
    expect(ru?.forbidden_collapses).toContain("recommendation promoted to decision");
    const code = byId.get("GC-010-code-literal-exact");
    expect(code?.source_revision_refs).toEqual(["golden-code-sample-r1"]);
    expect(code?.required_atoms).toContain("exactPhraseSearch is implemented");
    const table = byId.get("GC-011-table-number-with-conditions");
    expect(table?.source_revision_refs).toEqual(["golden-table-conditions-r1"]);
    expect(table?.required_atoms).toContain("ordinary JSON hard limit is 256 KiB in active generation");
    const dissent = byId.get("GC-012-en-dissent-negative");
    expect(dissent?.required_atoms).toContain("encrypted-stub-as-evidence approach was abandoned");
    expect(dissent?.forbidden_collapses).toContain("failed approach presented as active");
  });

  it("fails a collapsing extractor on the adjudicated corpus", async () => {
    const manifest = parseGoldenManifest(JSON.parse(await readFile(join(corpusDir, "manifest.json"), "utf8")));
    const cases = [];
    for (const file of manifest.case_files) {
      cases.push(parseGoldenCase(JSON.parse(await readFile(join(corpusDir, file), "utf8"))));
    }
    const targets = cases.filter((entry) =>
      entry.case_id === "GC-001-recommendation-vs-decision" || entry.case_id === "GC-002-hypothesis-vs-observation",
    );
    expect(targets).toHaveLength(2);
    const collapsed = runCollapsingExtractor(targets);
    expect(() => assertGoldenPromotionGate(collapsed)).toThrow("GOLDEN_PROMOTION_BLOCKED");
    for (const result of collapsed) {
      const golden = targets.find((entry) => entry.case_id === result.case_id);
      if (golden === undefined) throw new Error("missing golden case");
      const verdict = adjudicateGoldenCase(golden, {
        atoms: [...result.observed_atoms],
        forbidden: [...result.observed_forbidden_collapses],
        handles: [...result.resolved_handle_refs],
        coverage: result.coverage_kind,
      });
      expect(verdict.passed).toBe(false);
    }
  });

  it("keeps the corpus directory free of unlisted cases", async () => {
    const manifest = parseGoldenManifest(JSON.parse(await readFile(join(corpusDir, "manifest.json"), "utf8")));
    const listed = new Set(manifest.case_files);
    const onDisk = (await readdir(join(corpusDir, "cases"))).filter((name) => name.endsWith(".json")).map((name) => `cases/${name}`).sort();
    expect(onDisk).toEqual([...listed].sort());
  });
});
