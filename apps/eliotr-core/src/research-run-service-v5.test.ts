import { describe, expect, it } from "vitest";
import { INSTALLED_INQUIRY_PROTOCOL_REFS } from "@eliotr/cloudflare-research";
import { parseResearchRunTransportRequest, researchRunIdentityDigest } from "./research-run-service.js";

const selection = { configuration_project_id: "project-1", configuration_ref: `rpmc-${"a".repeat(64)}`,
  configuration_sha256: "a".repeat(64), selection_revision: 3 };
const base = { query: "Compare the papers", product: "RESEARCH", scope_expression: { kind: "GLOBAL_LIBRARY" },
  literals: [], budget_ref: "research-budget-v1", max_results: 16, request_version: "eliotr.research-run-request.v5",
  selection };

describe("Owner V5 research transport", () => {
  it("maps lookup to the installed lookup protocol without exposing the transport method downstream", async () => {
    const parsed = parseResearchRunTransportRequest({ ...base, method: "lookup", evidence_grade: "E0" });
    expect(parsed.request).toMatchObject({ request_version: "eliotr.research-run-request.v2",
      inquiry_protocol_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.lookup, evidence_grade: "E0" });
    expect(parsed.selection).toMatchObject({ request_version: "eliotr.research-run-request.v4", selection });
    expect(Object.keys(parsed.request).sort()).not.toContain("method");
    const review = parseResearchRunTransportRequest({ ...base, method: "evidence_review", evidence_grade: "E1" });
    expect(await researchRunIdentityDigest(parsed.request, parsed.selection))
      .not.toBe(await researchRunIdentityDigest(review.request, review.selection));
  });

  it.each(["E1", "E2"] as const)("maps evidence_review at %s to its installed protocol and binds it into identity", async (grade) => {
    const parsed = parseResearchRunTransportRequest({ ...base, method: "evidence_review", evidence_grade: grade });
    expect(parsed.request.inquiry_protocol_ref).toEqual(INSTALLED_INQUIRY_PROTOCOL_REFS.evidence_review);
    expect(parsed.request.evidence_grade).toBe(grade);
    expect(await researchRunIdentityDigest(parsed.request, parsed.selection)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects lookup grade mismatches, E0 review, and unknown transport fields", () => {
    expect(() => parseResearchRunTransportRequest({ ...base, method: "lookup", evidence_grade: "E1" }))
      .toThrow(expect.objectContaining({ code: "RESEARCH_PROFILE_UNSUPPORTED" }));
    expect(() => parseResearchRunTransportRequest({ ...base, method: "evidence_review", evidence_grade: "E0" }))
      .toThrow(expect.objectContaining({ code: "RESEARCH_PROFILE_UNSUPPORTED" }));
    expect(() => parseResearchRunTransportRequest({ ...base, method: "evidence_review", evidence_grade: null }))
      .toThrow(expect.objectContaining({ code: "RESEARCH_PROFILE_UNSUPPORTED" }));
    const withoutGrade = base;
    expect(() => parseResearchRunTransportRequest({ ...withoutGrade, method: "evidence_review" }))
      .toThrow(expect.objectContaining({ code: "RESEARCH_INPUT_INVALID" }));
    expect(() => parseResearchRunTransportRequest({ ...base, method: "lookup", evidence_grade: "E0", unknown: true }))
      .toThrow(expect.objectContaining({ code: "RESEARCH_INPUT_INVALID" }));
  });
});
