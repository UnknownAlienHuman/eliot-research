import { describe, expect, it, vi } from "vitest";
import type { ScopeExpression, ScopeSnapshot } from "@eliotr/contracts";
import { scopeExpressionIdentity, type DeterministicScopeAtom } from "@eliotr/domain";
import {
  projectionDigest,
  stableProjectionId,
  type ManagedTargetIdentity,
  type ManagedTargetSelectionReceipt,
} from "@eliotr/cloudflare-projection";
import type { EvidenceAccessContext } from "@eliotr/cloudflare-evidence";
import {
  ProjectCopyScopeError,
  resolveProjectCopyScope,
  type ProjectCopyMembershipFact,
  type ProjectCopyRequiredSetFacts,
} from "./project-copy-scope.js";
import { createOwnerScopeAuthority } from "./orientation-authority.js";

const FIXED_AT = "2026-10-14T12:00:00.000Z";
const target: ManagedTargetIdentity = {
  namespace: "eliot",
  managed_instance_id: "eliot-hybrid",
  managed_generation: "generation-v1",
  target_profile_identity_sha256: "a".repeat(64),
};

function project(project_id: string): ScopeExpression {
  return { kind: "PROJECT", project_id };
}

function combine(
  kind: "UNION" | "INTERSECT" | "EXCEPT",
  left: ScopeExpression,
  right: ScopeExpression,
): ScopeExpression {
  return { kind, left, right };
}

function snapshot(expression: ScopeExpression, refs: readonly string[]): ScopeSnapshot {
  return {
    snapshot_id: "scope-1",
    revision: 1,
    resolved_scope_expression: expression,
    participant_generations: {},
    member_source_revision_refs: [...refs].sort(),
    source_owner_generations: Object.fromEntries(refs.map((ref) => [ref, "owner-generation-1"])),
    policy_authority_ref: "policy-1",
    disclosure_closure_digest: "b".repeat(64),
    purge_ledger_revision: 0,
    digest: "c".repeat(64),
    created_at: FIXED_AT,
    expires_at: "2026-10-15T12:00:00.000Z",
  };
}

async function membership(
  source_revision_ref: string,
  project_id: string,
  membership_generation: number,
  identityVersion: 1 | 2 = 1,
  membership_revision = membership_generation,
  project_membership_generation = membership_generation,
): Promise<ProjectCopyMembershipFact> {
  const source_id = source_revision_ref;
  const membership_id = JSON.stringify([project_id, source_id]);
  const stable_project_membership_id = await stableProjectionId("project-membership", membership_id);
  const legacy_project_membership_id = identityVersion === 1
    ? `project:${project_id}:generation:${membership_generation}`
    : null;
  return {
    source_revision_ref,
    source_id,
    source_owner_generation: "owner-generation-1",
    project_id,
    project_membership_id: legacy_project_membership_id ?? stable_project_membership_id,
    stable_project_membership_id,
    legacy_project_membership_id,
    project_membership_identity_version: identityVersion,
    membership_id,
    membership_revision,
    membership_generation,
    project_membership_generation,
    assignment_decision_version: identityVersion,
  };
}

async function requiredSet(
  scope: ScopeSnapshot,
  copies: readonly ProjectCopyMembershipFact[],
  targetSelection: ManagedTargetSelectionReceipt = {
    protocol: "eliotr.managed-target-selection.v1",
    domain: "MANAGED_TARGET_ASSIGNMENT",
    decision_version: 1,
    selection_mode: "EXACT_GENERATION_V1",
    target,
  },
): Promise<ProjectCopyRequiredSetFacts> {
  const assignedProjectCount = Math.max(1, new Set(copies.map(copy => copy.project_id)).size);
  const common = {
    target,
    as_of: scope.created_at,
    assigned_project_count: assignedProjectCount,
    page_count: 1,
    project_revision_copy_count: copies.length,
    required_set_digest: "d".repeat(64),
    copies,
  };
  if (targetSelection.decision_version === 2) {
    const selectionDigest = await projectionDigest(targetSelection);
    return {
      ...common,
      protocol: "eliotr.managed-required-project-revisions.v3",
      target_selection: targetSelection,
      target_fence: {
        protocol: "eliotr.managed-required-set-target-fence.v2",
        digest: "f".repeat(64),
        target_selection_sha256: selectionDigest,
        assignment_heads_sha256: "a".repeat(64),
        required_set_sha256: "d".repeat(64),
        page_provenance_sha256: "c".repeat(64),
        assigned_project_count: assignedProjectCount,
        project_revision_copy_count: copies.length,
        page_count: 1,
      },
    };
  }
  return {
    ...common,
    protocol: "eliotr.managed-required-project-revisions.v2",
    target_fence: {
      protocol: "eliotr.managed-required-set-target-fence.v1",
      digest: "f".repeat(64),
      assignment_heads_sha256: "a".repeat(64),
      required_set_sha256: "d".repeat(64),
      page_provenance_sha256: "c".repeat(64),
      assigned_project_count: assignedProjectCount,
      project_revision_copy_count: copies.length,
      page_count: 1,
    },
  };
}

function atomResolver(rows: Readonly<Record<string, readonly string[]>>) {
  return async (atom: DeterministicScopeAtom) => {
    const members = rows[scopeExpressionIdentity(atom)] ?? [];
    return {
      atom_generation_ref: `atom-${members.length}`,
      members: members.map((source_revision_ref) => ({
        source_revision_ref,
        source_owner_generation: "owner-generation-1",
        policy_closure_ref: "policy-closure-1",
      })),
    };
  };
}

async function resolve(input: {
  readonly scope: ScopeSnapshot;
  readonly atom_members: Readonly<Record<string, readonly string[]>>;
  readonly copies: readonly (ProjectCopyMembershipFact | Promise<ProjectCopyMembershipFact>)[];
  readonly selection?: ManagedTargetSelectionReceipt;
  readonly currentness?: () => Promise<void>;
}) {
  const requireCurrent = vi.fn(input.currentness ?? (async () => undefined));
  const copies = await Promise.all(input.copies);
  const result = await resolveProjectCopyScope({
    scope_snapshot: input.scope,
    observed_at: FIXED_AT,
    target,
    ...(input.selection === undefined ? {} : { selection: input.selection }),
    require_current_scope: requireCurrent,
    resolve_atom: atomResolver(input.atom_members),
    load_required_set: async (readTarget, asOf, refs, selection) => {
      expect(readTarget).toEqual(target);
      expect(asOf).toBe(input.scope.created_at);
      expect(refs).toEqual(input.scope.member_source_revision_refs);
      return requiredSet(input.scope, copies, selection);
    },
  });
  return { result, requireCurrent };
}

describe("Core-backed project-copy scope", () => {
  it("binds empty PROJECT scopes to the membership head and ignores metadata-only revisions", async () => {
    let metadataGeneration = 1;
    let membershipGeneration = 8;
    const statements: { readonly sql: string; readonly values: readonly unknown[] }[] = [];
    const database = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            statements.push({ sql, values });
            return {
              async all() {
                if (sql.includes("FROM scope_read_policy")) {
                  return {
                    success: true,
                    results: [{
                      source_namespace_id: "namespace-1",
                      policy_ref: "policy-1",
                      generation: 1,
                      allowed_use_json: '["research"]',
                      disclosure_ceiling: "private",
                      expires_at: "2030-01-01T00:00:00.000Z",
                    }],
                  };
                }
                if (sql.includes("FROM source s JOIN source_revision r")) {
                  return { success: true, results: [] };
                }
                throw new Error(`unexpected authority query: ${sql}`);
              },
              async first() {
                if (sql.includes("FROM project p")) {
                  return {
                    project_id: "project-empty",
                    generation: metadataGeneration,
                    membership_generation: membershipGeneration,
                    default_disclosure: "private",
                    default_source_policy_ref: "source-policy-1",
                    retention_policy_ref: "retention-1",
                  };
                }
                throw new Error(`unexpected authority read: ${sql}`);
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const access = {
      principal_ref: "owner-1",
      client_class: "owner_pwa",
      credential_generation: "credential-1",
    } as EvidenceAccessContext;
    const authority = createOwnerScopeAuthority(database, access, () => Date.parse(FIXED_AT));
    const atom: DeterministicScopeAtom = { kind: "PROJECT", project_id: "project-empty" };

    const initial = await authority.resolveAtom(atom, FIXED_AT);
    metadataGeneration += 1;
    const afterTitleChange = await authority.resolveAtom(atom, FIXED_AT);
    expect(afterTitleChange.atom_generation_ref).toBe(initial.atom_generation_ref);

    membershipGeneration += 1;
    const afterEmptyMembershipChange = await authority.resolveAtom(atom, FIXED_AT);
    expect(afterEmptyMembershipChange.atom_generation_ref).not.toBe(initial.atom_generation_ref);

    const sourceResolution = statements.filter(({ sql }) => sql.includes("FROM source s JOIN source_revision r")).at(-1);
    expect(sourceResolution?.sql).toContain("m.membership_generation=?4");
    expect(sourceResolution?.sql).toContain("p.membership_generation=?4");
    expect(sourceResolution?.values.at(-3)).toBe("project-empty");
    expect(sourceResolution?.values.at(-2)).toBe(9);
  });

  it("chooses one canonical representative for a source-only query spanning project copies", async () => {
    const expression: ScopeExpression = { kind: "GLOBAL_LIBRARY" };
    const scope = snapshot(expression, ["revision-shared"]);
    const { result, requireCurrent } = await resolve({
      scope,
      atom_members: { [scopeExpressionIdentity(expression)]: ["revision-shared"] },
      copies: [
        membership("revision-shared", "project-b", 4),
        membership("revision-shared", "project-a", 7),
      ],
    });

    expect(result.layout).toBe("PROJECT_COPY_V1");
    expect(result.representative_policy).toBe("ONE_CANONICAL_COPY_PER_SOURCE_REVISION");
    expect(result.copies).toHaveLength(1);
    expect(result.copies[0]).toMatchObject({
      source_revision_ref: "revision-shared",
      project_id: "project-a",
      project_membership_id: "project:project-a:generation:7",
    });
    expect(requireCurrent).toHaveBeenCalledTimes(2);
  });

  it("preserves UNION, INTERSECT, and ordered EXCEPT membership semantics", async () => {
    const a = project("project-a");
    const b = project("project-b");
    const shared = "revision-shared";
    const onlyA = "revision-a";
    const onlyB = "revision-b";
    const rows = {
      [scopeExpressionIdentity(a)]: [shared, onlyA],
      [scopeExpressionIdentity(b)]: [shared, onlyB],
    };

    const unionExpr = combine("UNION", a, b);
    const union = await resolve({
      scope: snapshot(unionExpr, [shared, onlyA, onlyB]),
      atom_members: rows,
      copies: [
        membership(shared, "project-a", 7),
        membership(shared, "project-b", 4),
        membership(onlyA, "project-a", 7),
        membership(onlyB, "project-b", 4),
      ],
    });
    expect(union.result.copies.map((copy) => [copy.source_revision_ref, copy.project_id]))
      .toEqual([[onlyA, "project-a"], [onlyB, "project-b"], [shared, "project-a"]]);

    const intersectionExpr = combine("INTERSECT", a, b);
    const intersection = await resolve({
      scope: snapshot(intersectionExpr, [shared]),
      atom_members: rows,
      copies: [membership(shared, "project-a", 7), membership(shared, "project-b", 4)],
    });
    expect(intersection.result.copies.map((copy) => copy.project_id)).toEqual(["project-a"]);

    const exceptExpr = combine("EXCEPT", a, b);
    const except = await resolve({
      scope: snapshot(exceptExpr, [onlyA]),
      atom_members: rows,
      copies: [
        membership(shared, "project-a", 7),
        membership(shared, "project-b", 4),
        membership(onlyA, "project-a", 7),
      ],
    });
    expect(except.result.copies.map((copy) => [copy.source_revision_ref, copy.project_id]))
      .toEqual([[onlyA, "project-a"]]);
  });

  it("keeps the source in the denominator after one membership is removed", async () => {
    const expression: ScopeExpression = { kind: "GLOBAL_LIBRARY" };
    const scope = snapshot(expression, ["revision-shared"]);
    const { result } = await resolve({
      scope,
      atom_members: { [scopeExpressionIdentity(expression)]: ["revision-shared"] },
      // Current Core required-set readback contains only the surviving project-B membership.
      copies: [membership("revision-shared", "project-b", 5)],
    });

    expect(scope.member_source_revision_refs).toEqual(["revision-shared"]);
    expect(result.copies).toHaveLength(1);
    expect(result.copies[0]).toMatchObject({ project_id: "project-b", membership_generation: 5 });
  });

  it("binds V2 copy keys to the bounded pair id and per-membership revision", async () => {
    const expression = project("project-v2");
    const scope = snapshot(expression, ["revision-v2"]);
    const selection = Object.freeze({
      protocol: "eliotr.managed-target-selection.v2" as const,
      domain: "MANAGED_SEARCH_PRODUCT" as const,
      decision_version: 2 as const,
      selection_mode: "STABLE_PHYSICAL_PROFILE_V2" as const,
      product_alias: "primary" as const,
      purpose: "SHADOW" as const,
      registry_revision: 8,
      registry_artifact_sha256: "d".repeat(64),
      v1_exact_profile_identity_sha256: "e".repeat(64),
      target,
    });
    const older = await membership("revision-v2", "project-v2", 2, 2, 2, 2);
    const active = await membership("revision-v2", "project-v2", 5, 2, 3, 8);
    expect(active.stable_project_membership_id).toBe(older.stable_project_membership_id);
    expect(active.membership_revision).toBe(3);

    const { result } = await resolve({
      scope,
      selection,
      atom_members: { [scopeExpressionIdentity(expression)]: ["revision-v2"] },
      copies: [active],
    });
    const versioned = result as unknown as {
      readonly layout: "PROJECT_COPY_V2";
      readonly target_selection: typeof selection;
      readonly copies: readonly {
        readonly project_membership_id: string;
        readonly membership_generation: number;
        readonly membership_revision: number;
        readonly project_membership_generation: number;
        readonly membership_identity_version: 2;
        readonly folder_prefix: string;
      }[];
    };
    expect(versioned.layout).toBe("PROJECT_COPY_V2");
    expect(versioned.target_selection).toEqual(selection);
    expect(versioned.copies[0]).toMatchObject({
      project_membership_id: active.stable_project_membership_id,
      membership_generation: 5,
      membership_revision: 3,
      project_membership_generation: 8,
      membership_identity_version: 2,
    });
    expect(versioned.copies[0]?.folder_prefix).toMatch(/^projection\/p-[a-f0-9]{48}\/$/u);
    expect(new TextEncoder().encode(versioned.copies[0]?.folder_prefix ?? "").byteLength).toBeLessThan(64);
  });

  it("keeps exact V1 row identity inside a V2 target-selection receipt", async () => {
    const expression = project("project-mixed");
    const scope = snapshot(expression, ["revision-v1-exact"]);
    const selection = Object.freeze({
      protocol: "eliotr.managed-target-selection.v2" as const,
      domain: "MANAGED_SEARCH_PRODUCT" as const,
      decision_version: 2 as const,
      selection_mode: "STABLE_PHYSICAL_PROFILE_V2" as const,
      product_alias: "primary" as const,
      purpose: "ACTIVE" as const,
      registry_revision: 9,
      registry_artifact_sha256: "f".repeat(64),
      v1_exact_profile_identity_sha256: "e".repeat(64),
      target,
    });
    const exactV1Copy = await membership("revision-v1-exact", "project-mixed", 5, 1, 2, 7);
    const { result } = await resolve({
      scope,
      selection,
      atom_members: { [scopeExpressionIdentity(expression)]: ["revision-v1-exact"] },
      copies: [exactV1Copy],
    });
    const versioned = result as unknown as {
      readonly layout: "PROJECT_COPY_V2";
      readonly target_selection: typeof selection;
      readonly copies: readonly {
        readonly project_membership_id: string;
        readonly membership_identity_version: 1;
        readonly legacy_project_membership_id: string;
        readonly membership_revision?: number;
        readonly stable_project_membership_id?: string;
      }[];
    };

    expect(versioned.layout).toBe("PROJECT_COPY_V2");
    expect(versioned.target_selection).toEqual(selection);
    expect(versioned.copies[0]).toMatchObject({
      project_membership_id: "project:project-mixed:generation:5",
      membership_identity_version: 1,
      legacy_project_membership_id: "project:project-mixed:generation:5",
    });
    expect(versioned.copies[0]).not.toHaveProperty("membership_revision");
    expect(versioned.copies[0]).not.toHaveProperty("stable_project_membership_id");
  });

  it("fails before provider resolution when Core facts do not cover a frozen source", async () => {
    const expression: ScopeExpression = { kind: "GLOBAL_LIBRARY" };
    const scope = snapshot(expression, ["revision-unassigned"]);
    await expect(resolveProjectCopyScope({
      scope_snapshot: scope,
      observed_at: FIXED_AT,
      target,
      require_current_scope: async () => undefined,
      resolve_atom: atomResolver({ [scopeExpressionIdentity(expression)]: ["revision-unassigned"] }),
      load_required_set: async () => requiredSet(scope, []),
    })).rejects.toBeInstanceOf(ProjectCopyScopeError);
  });

  it("rejects stale source-owner generations and propagates currentness fences", async () => {
    const expression: ScopeExpression = { kind: "GLOBAL_LIBRARY" };
    const scope = snapshot(expression, ["revision-shared"]);
    const staleCopy = await membership("revision-shared", "project-a", 7);
    await expect(resolve({
      scope,
      atom_members: { [scopeExpressionIdentity(expression)]: ["revision-shared"] },
      copies: [{ ...staleCopy, source_owner_generation: "stale-owner" }],
    })).rejects.toMatchObject({ code: "PROJECT_COPY_SCOPE_REQUIRED_SET_INVALID" });
    await expect(resolve({
      scope,
      atom_members: { [scopeExpressionIdentity(expression)]: ["revision-shared"] },
      copies: [membership("revision-shared", "project-a", 7)],
      currentness: async () => { throw new Error("project membership head changed"); },
    })).rejects.toThrow("project membership head changed");
  });

  it.each(["legacy", "different denominator"])("rejects %s required-set receipts", async (kind) => {
    const expression: ScopeExpression = { kind: "PROJECT", project_id: "project-a" };
    const scope = snapshot(expression, ["revision-shared"]);
    const facts = await requiredSet(scope, [await membership("revision-shared", "project-a", 7)]);
    const invalidFacts = kind === "legacy"
      ? { ...facts, protocol: "eliotr.managed-required-project-revisions.v1" }
      : { ...facts, target_fence: { ...facts.target_fence, required_set_sha256: "e".repeat(64) } };
    await expect(resolveProjectCopyScope({
      scope_snapshot: scope,
      observed_at: FIXED_AT,
      target,
      require_current_scope: async () => undefined,
      resolve_atom: atomResolver({ [scopeExpressionIdentity(expression)]: ["revision-shared"] }),
      load_required_set: async () => invalidFacts as ProjectCopyRequiredSetFacts,
    })).rejects.toMatchObject({ code: "PROJECT_COPY_SCOPE_REQUIRED_SET_INVALID" });
  });
});
