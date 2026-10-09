import { describe, expect, it } from "vitest";
import type { ScopeSnapshot } from "@eliotr/contracts";
import type { NavigationStore } from "@eliotr/retrieval";
import { MAX_OMISSION_SAMPLE } from "@eliotr/retrieval";
import { createNavigationService } from "./navigation-service.js";

const NOW = "2026-10-08T00:00:00.000Z";

function fixture(size: number, missingCard?: string, missingMap?: string) {
  const members = Array.from({ length: size }, (_, index) => `revision-${String(index).padStart(3, "0")}`);
  const scope: ScopeSnapshot = {
    snapshot_id: "scope-work", revision: 1, resolved_scope_expression: { kind: "GLOBAL_LIBRARY" },
    participant_generations: { local: "generation-1" }, member_source_revision_refs: members,
    source_owner_generations: Object.fromEntries(members.map((ref) => [ref, "generation-1"])),
    policy_authority_ref: "policy-1", disclosure_closure_digest: "a".repeat(64),
    purge_ledger_revision: 0, digest: "b".repeat(64), created_at: NOW, expires_at: "2026-10-09T00:00:00.000Z",
  };
  const cardReads: string[][] = [];
  let currentnessReads = 0;
  const store: NavigationStore = {
    async requireCurrentScopeSnapshot() { currentnessReads += 1; return scope; },
    async getSourceCards(refs) {
      cardReads.push([...refs]);
      return refs.filter((ref) => ref !== missingCard).map((ref) => ({
        card_ref: { id: `card-${ref}`, revision: 1 }, source_revision_ref: ref, title: ref,
        authors: [], language: "en", source_kind: "document", document_role: "primary",
        authority_hint: "unknown", abstract: "Metadata only", main_topics: [], controlled_vocabulary: [],
        outline: [], important_section_refs: [], likely_uses: [], quality_status: "standard",
        generator_generation: "metadata-1", created_at: NOW,
      }));
    },
    async getDocumentMaps(refs) {
      return refs.filter((ref) => ref !== missingMap).map((ref) => ({
        map_ref: { id: `map-${ref}`, revision: 1 }, source_revision_ref: ref,
        section_hierarchy: [], page_ranges: [], figures: [], tables: [], named_entities: [],
        dates_and_versions: [], external_citations: [], key_terms: [], high_information_section_refs: [],
        unresolved_structure: [], generator_generation: "metadata-1", created_at: NOW,
      }));
    },
    async getSourceCardsByRefs() { throw new Error("Unexpected atlas read"); },
    async getProjectAtlas() { throw new Error("Unexpected atlas read"); },
    async getEvidenceHandleForSection() { throw new Error("Metadata preview cannot resolve evidence"); },
  };
  return { scope, cardReads, store, currentnessReads: () => currentnessReads };
}

describe("actual bounded orientation work", () => {
  it.each([65, 299])("preserves %i frozen members while examining 64 and representing 16", async (size) => {
    const f = fixture(size);
    const { navigation, work } = await createNavigationService(f.store).orientWithWork({
      scope_snapshot: f.scope, focus_terms: [], maximum_sources: 16,
    });
    expect(f.scope.member_source_revision_refs).toHaveLength(size);
    expect(f.cardReads).toEqual([f.scope.member_source_revision_refs.slice(0, 64)]);
    expect(work).toMatchObject({
      protocol: "eliotr.orientation.work.v1", frozen_members: size,
      preview_candidates_examined: 64, metadata_candidates_ranked: 64, represented_sources: 16,
      provider_candidates_returned: 0, diversity_candidates_examined: 0,
      exact_resolution_attempts: 0, resolved_evidence: 0,
      represented_source_families: null, family_measurement: "NOT_MEASURED", omitted_count: size - 16,
    });
    expect(navigation.represented_source_revision_refs).toHaveLength(16);
    expect(navigation.coverage_kind).toBe("unknown");
    expect(navigation).not.toHaveProperty("work");
    expect(Object.isFrozen(work)).toBe(true);
    expect(Object.isFrozen(work.omitted_sample)).toBe(true);
    expect(work.omitted_sample.length).toBe(Math.min(work.omitted_count, MAX_OMISSION_SAMPLE));
    expect(f.currentnessReads()).toBeGreaterThanOrEqual(2);
  });

  it("uses the actual smaller candidate bound and retains explicit missing metadata omissions", async () => {
    const f = fixture(299, "revision-000", "revision-001");
    const { navigation, work } = await createNavigationService(f.store).orientWithWork({
      scope_snapshot: f.scope, focus_terms: [], maximum_sources: 4,
    });
    expect(f.cardReads[0]).toHaveLength(16);
    expect(work).toMatchObject({ frozen_members: 299, preview_candidates_examined: 16,
      metadata_candidates_ranked: 15, represented_sources: 4, omitted_count: 295 });
    expect(navigation.omissions).toEqual(expect.arrayContaining([
      { source_revision_ref: "revision-000", reason: "SOURCE_CARD_MISSING" },
      { source_revision_ref: "revision-001", reason: "DOCUMENT_MAP_MISSING" },
    ]));
    expect(navigation.navigation_authority).toBe("NAVIGATION_ONLY");
    expect(navigation.coverage_kind).toBe("unknown");
  });
});
