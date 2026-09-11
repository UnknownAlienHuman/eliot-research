import { describe, expect, it } from "vitest";
import type { WikiPageRevision } from "@eliotr/contracts";
import {
  wikiMayAutoPromote,
  wikiMayBePublished,
  wikiPublicationIssues,
  wikiTargetsExpectedHead,
  type WikiAutoPromotionAuthority,
} from "./publication.js";

function page(fields: Partial<WikiPageRevision> = {}): WikiPageRevision {
  return {
    page_ref: { id: "page-1", revision: 1 },
    page_type: "Source",
    title: "Primary source",
    scope_snapshot_ref: { id: "scope-1", revision: 1 },
    body_object_ref: "wiki-body-1",
    body_sha256: "a".repeat(64),
    statement_labels: { "claim-1": "SOURCE_SUPPORTED" },
    evidence_map_ref: "evidence-map-1",
    counterposition_refs: [],
    coverage_receipt_ref: { id: "coverage-1", revision: 1 },
    limitations: [],
    dependency_refs: ["source-revision-1"],
    generator_generation: "wiki-generator-1",
    status: "DRAFT",
    publication_metadata: { origin: "test" },
    created_at: "2026-09-11T00:00:00.000Z",
    ...fields,
  };
}

const authority: WikiAutoPromotionAuthority = {
  explicit_project_policy: true,
  policy_receipt_ref: "policy-receipt-1",
  exact_evidence_complete: true,
  evidence_receipt_ref: "evidence-receipt-1",
  dependency_closure_complete: true,
  coverage_complete: true,
  independent_verifier_receipt_ref: "verifier-receipt-1",
  conflict_count: 0,
  changes_current_state: false,
};

describe("wiki publication domain", () => {
  it("accepts a fully bound draft and binds each revision to its exact predecessor", () => {
    expect(wikiPublicationIssues(page())).toEqual([]);
    expect(wikiMayBePublished(page())).toBe(true);
    expect(wikiTargetsExpectedHead(page(), null, null)).toBe(true);
    const second = page({
      page_ref: { id: "page-1", revision: 2 },
      supersedes_ref: { id: "page-1", revision: 1 },
    });
    expect(wikiTargetsExpectedHead(second, 1, 1)).toBe(true);
    expect(wikiTargetsExpectedHead(second, 2, 1)).toBe(false);
  });

  it("rejects unresolved claims without limitations and contested claims without counterpositions", () => {
    const candidate = page({
      statement_labels: { "claim-1": "CONTESTED", "claim-2": "UNRESOLVED" },
    });
    expect(wikiPublicationIssues(candidate)).toEqual(expect.arrayContaining([
      "CONTESTED_WITHOUT_COUNTERPOSITION",
      "UNRESOLVED_WITHOUT_LIMITATION",
    ]));
    expect(wikiMayBePublished(candidate)).toBe(false);
  });

  it("rejects duplicate, self-referential and discontinuous dependency lineage", () => {
    const candidate = page({
      page_ref: { id: "page-1", revision: 3 },
      supersedes_ref: { id: "page-1", revision: 1 },
      dependency_refs: ["page-1", "page-1"],
    });
    expect(wikiPublicationIssues(candidate)).toEqual(expect.arrayContaining([
      "REVISION_LINEAGE_INVALID",
      "DEPENDENCY_INVALID",
      "DEPENDENCY_SELF_REFERENCE",
    ]));
  });

  it("permits D0/D1 auto-promotion only with exact explicit authority and never permits D2/D3", () => {
    expect(wikiMayAutoPromote(page(), "D1_LOW_RISK_ADDITIVE", authority)).toBe(true);
    expect(wikiMayAutoPromote(page(), "D2_ANALYTICAL", authority)).toBe(false);
    expect(wikiMayAutoPromote(page(), "D3_AUTHORITY_SENSITIVE", authority)).toBe(false);
    expect(wikiMayAutoPromote(page(), "D1_LOW_RISK_ADDITIVE", {
      ...authority,
      explicit_project_policy: false,
    })).toBe(false);
    expect(wikiMayAutoPromote(page({ page_type: "Hypothesis" }), "D1_LOW_RISK_ADDITIVE", authority)).toBe(false);
    expect(wikiMayAutoPromote(page({
      statement_labels: { "claim-1": "DERIVED_INFERENCE" },
    }), "D1_LOW_RISK_ADDITIVE", authority)).toBe(false);
  });
});
