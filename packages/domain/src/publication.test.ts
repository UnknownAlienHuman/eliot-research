import { describe, expect, it } from "vitest";
import type { WikiPageRevision } from "@eliotr/contracts";
import {
  wikiMayBePublished,
  wikiPublicationIssues,
  wikiTargetsExpectedHead,
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
});
