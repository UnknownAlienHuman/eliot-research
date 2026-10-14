import { describe, expect, it, vi } from "vitest";
import type { ScopeSnapshot } from "../../packages/contracts/src/index.js";
import { resolveProjectCopyScope } from "../../packages/cloudflare-navigation/src/project-copy-scope.js";
import { createAiSearchScopeFilter } from "../../packages/cloudflare-projection/src/ai-search-scope-filter.js";
import { managedProjectFolderPrefix } from "../../packages/cloudflare-projection/src/managed-project-path.js";
import { decodeAiSearchSearchResult } from "../../packages/platform-cloudflare/src/ai-search.js";

describe("integrated project-copy filter and decoder", () => {
  it("filters project A before one query and rejects project B for the same source revision", async () => {
    const asOf = "2026-10-14T16:00:00.000Z";
    const target = {
      namespace: "eliotr", managed_instance_id: "instance-1", managed_generation: "generation-1",
      target_profile_identity_sha256: "a".repeat(64),
    };
    const scope: ScopeSnapshot = {
      snapshot_id: "scope-project-a", revision: 1,
      resolved_scope_expression: { kind: "PROJECT", project_id: "project-a" },
      participant_generations: {}, member_source_revision_refs: ["revision-shared"],
      source_owner_generations: { "revision-shared": "owner-generation-1" },
      policy_authority_ref: "policy-1", disclosure_closure_digest: "b".repeat(64),
      purge_ledger_revision: 0, digest: "c".repeat(64), created_at: asOf,
      expires_at: "2026-10-15T16:00:00.000Z",
    };
    const copies = ["project-a", "project-b"].map(projectId => ({
      source_revision_ref: "revision-shared", source_owner_generation: "owner-generation-1",
      project_id: projectId, project_membership_id: `project:${projectId}:generation:1`, membership_generation: 1,
    }));
    const selected = await resolveProjectCopyScope({
      scope_snapshot: scope, observed_at: asOf, target,
      require_current_scope: async () => undefined,
      resolve_atom: async () => ({
        atom_generation_ref: "project-a-membership-1",
        members: [{ source_revision_ref: "revision-shared", source_owner_generation: "owner-generation-1", policy_closure_ref: "policy-closure-1" }],
      }),
      load_required_set: async () => ({
        protocol: "eliotr.managed-required-project-revisions.v2", target, as_of: asOf,
        assigned_project_count: 2, project_revision_copy_count: 2, page_count: 1,
        required_set_digest: "d".repeat(64), copies,
        target_fence: {
          protocol: "eliotr.managed-required-set-target-fence.v1", digest: "e".repeat(64),
          assignment_heads_sha256: "f".repeat(64), required_set_sha256: "d".repeat(64),
          page_provenance_sha256: "1".repeat(64), assigned_project_count: 2,
          project_revision_copy_count: 2, page_count: 1,
        },
      }),
    });
    expect(selected.copies).toHaveLength(1);
    expect(selected.copies[0]?.project_id).toBe("project-a");
    const foreignFolder = await managedProjectFolderPrefix({
      instance_id: target.managed_instance_id, projection_generation: target.managed_generation,
      source_revision_ref: "revision-shared", project_id: "project-b",
      project_membership_id: "project:project-b:generation:1", membership_generation: 1,
    });
    const filters = createAiSearchScopeFilter(scope.member_source_revision_refs,
      selected.generation_metadata_value, selected.copies);
    const provider = vi.fn(async (input: { readonly filters: typeof filters }) => {
      expect(input.filters.folder.$in).toEqual([selected.copies[0]?.folder_prefix]);
      expect(input.filters.folder.$in).not.toContain(foreignFolder);
      return {
        search_query: "question", chunks: [{ id: "foreign-project-chunk", type: "text", score: 0.9, text: "preview",
          item: { key: `${foreignFolder}projection-${"a".repeat(48)}.md`, metadata: {
            canonical_section_id: "section-1", content_sha256: "b".repeat(64), instruction_taint: "CLEARED",
            projection_generation: selected.generation_metadata_value, source_revision_ref: "revision-shared",
          } },
        }],
      };
    });
    const result = await provider({ filters });
    expect(() => decodeAiSearchSearchResult({
      raw_query: "question", product: "FAST_SEARCH", scope_snapshot: scope, literals: [],
      requested_limit: 1, deadline_ms: Date.parse(asOf) + 10_000,
    }, result, {
      expected_index_generation: target.managed_generation, project_copy_layout: "PROJECT_COPY_V1",
      expected_generation_metadata_value: selected.generation_metadata_value,
      expected_project_copies: selected.copies, requested_lanes: ["SEM"], max_results: 1, max_preview_bytes: 4096,
    })).toThrow(/project|folder/iu);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
