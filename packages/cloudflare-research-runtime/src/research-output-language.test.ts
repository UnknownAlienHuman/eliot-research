import { describe, expect, it } from "vitest";
import type { TrustedModelPromptParameters } from "@eliotr/cloudflare-research";
import { bindResearchSynthesisOutputLanguage } from "./research-output-language.js";

const trusted: TrustedModelPromptParameters = Object.freeze({
  prompt: "Trusted synthesis prompt",
  max_tokens: 1024,
});

describe("run-frozen synthesis output language", () => {
  it("preserves old prompt bytes when a run has no explicit language", () => {
    expect(bindResearchSynthesisOutputLanguage(trusted, undefined)).toBe(trusted);
  });

  it.each([
    ["en", "OUTPUT LANGUAGE: English."],
    ["ru", "OUTPUT LANGUAGE: Russian."],
  ] as const)("adds the explicit %s instruction to only that run's trusted synthesis request", (language, marker) => {
    const result = bindResearchSynthesisOutputLanguage(trusted, language);
    expect(result.prompt).toContain("Trusted synthesis prompt");
    expect(result.prompt).toContain(marker);
    expect(result.prompt).toContain("Preserve source quotations in their original language.");
    expect(result).not.toBe(trusted);
  });

  it("fails closed on an invalid frozen language value", () => {
    expect(() => bindResearchSynthesisOutputLanguage(trusted, "fr" as never))
      .toThrow("research output language is invalid");
  });
});
