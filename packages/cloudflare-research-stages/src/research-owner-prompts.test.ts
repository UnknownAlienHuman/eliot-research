import { describe, expect, it } from "vitest";
import {
  RESEARCH_OWNER_AUDIT_PROMPT,
  selectResearchOwnerPrompt,
} from "./research-owner-prompts.js";

describe("research owner claim-audit prompt", () => {
  it("defines the required checks against the trusted per-claim criteria", () => {
    expect(RESEARCH_OWNER_AUDIT_PROMPT).toContain("required_precision and required_source_class");
    expect(RESEARCH_OWNER_AUDIT_PROMPT).toContain("value_or_measurement_verification as checking each asserted numeric or measurable result");
    expect(RESEARCH_OWNER_AUDIT_PROMPT).toContain("specification_compliance as checking only an explicit specification, threshold, condition, or criterion stated in the claim, trusted audit policy, or cited evidence");
    expect(RESEARCH_OWNER_AUDIT_PROMPT).toContain("method_artifact_alignment as checking whether substantive cited prose connects the method");
    expect(RESEARCH_OWNER_AUDIT_PROMPT).toContain("A title or bibliography entry alone does not establish adoption");
    expect(RESEARCH_OWNER_AUDIT_PROMPT).toContain("Source resolution or source-level support alone does not prove excerpt sufficiency");
    expect(RESEARCH_OWNER_AUDIT_PROMPT).toContain("does not determine whether the larger research question is complete or covered");
    expect(RESEARCH_OWNER_AUDIT_PROMPT).not.toMatch(/\b(?:ImageNet|BN-x5|CIFAR-10|Adam)\b/u);
  });

  it("preserves unresolved evidence in schema and prompt-json provider modes", () => {
    const schemaMode = selectResearchOwnerPrompt("AUDIT_CLAIMS", "json_schema");
    const promptJsonMode = selectResearchOwnerPrompt("AUDIT_CLAIMS", "prompt_json");

    expect(schemaMode.prompt).toBe(RESEARCH_OWNER_AUDIT_PROMPT);
    expect(promptJsonMode.prompt).toContain(RESEARCH_OWNER_AUDIT_PROMPT);
    expect(RESEARCH_OWNER_AUDIT_PROMPT).toContain("a required NOT_APPLICABLE remains unresolved");
    expect(RESEARCH_OWNER_AUDIT_PROMPT).toContain("Do not force PASS or FAIL when evidence is insufficient");
    expect(schemaMode.output_schema).toBe(promptJsonMode.output_schema);
  });
});
