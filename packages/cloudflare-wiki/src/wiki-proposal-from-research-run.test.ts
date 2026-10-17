import { describe, expect, it } from "vitest";
import { GENERATOR, researchWikiDraftTitle } from "./wiki-proposal-from-research-run.js";

describe("Research-to-Wiki draft titles", () => {
  it("uses the saved question and keeps the generated title within the existing Studio bound", () => {
    expect(researchWikiDraftTitle("  Why   did the result change?  ", "2026-10-17T12:00:00.000Z"))
      .toBe("Why did the result change?");
    const longQuestion = "😀".repeat(300);
    const title = researchWikiDraftTitle(longQuestion, "2026-10-17T12:00:00.000Z");
    expect(title.length).toBeLessThanOrEqual(512);
    expect(title.endsWith("…")).toBe(true);
  });

  it("keeps the date fallback when historical goal data is unavailable and versions the generator", () => {
    expect(researchWikiDraftTitle(undefined, "2026-10-17T12:00:00.000Z"))
      .toBe("Research draft · 2026-10-17");
    expect(GENERATOR).toBe("wiki-from-research-run-v2");
  });
});
