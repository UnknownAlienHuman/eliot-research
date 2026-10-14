import type { SourceRevision } from "@eliotr/contracts";
import type { AiSearchInstanceProfile, EvidenceObjectStore, ImmutableObjectReceipt } from "@eliotr/platform-cloudflare";
import { describe, expect, it } from "vitest";
import { projectionDigest, projectionSha256Utf8 } from "./canonical.js";
import { AI_SEARCH_PRIMARY_PROJECTION_PROFILE } from "./ai-search-primary-profile.js";
import { aiSearchPhysicalProfileDigest } from "./ai-search-profile-identity-digest.js";
import {
  advanceManagedTargetManifest,
  MANAGED_TARGET_MANIFEST_COPY_LAYOUT,
  type CanonicalSourceProjectionReceipt,
  type ManagedProjectCopyMapReceipt,
  type ManagedTargetManifestInput,
  type ManagedTargetManifestProfile,
  type ManagedTargetManifestShadowFence,
} from "./managed-target-manifest.js";
import {
  MANAGED_TARGET_FREE_FILE_LIMIT,
  MANAGED_TARGET_HYBRID_FILE_LIMIT,
  assertManagedTargetProviderCapacity,
  providerCopySetDigest,
  providerItemSetDigest,
  sourceResidencyWorkPrefix,
  validateManagedTargetProviderCapacityReceipt,
} from "./managed-target-manifest-fragments.js";
import { foldManagedTargetManifestPage, initialManagedTargetManifestScan } from "./managed-target-manifest-continuation.js";
import { validateManifestProfile, validateShadowFence } from "./managed-target-manifest-step-support.js";
import type { ManagedRequiredProjectRevisionCopy } from "./managed-required-set.js";

const AS_OF = "2026-10-14T16:00:00.000Z";
const OWNER_EXPIRY = "2027-01-01T00:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function sourceRevision(sourceId: string, contentSha: string): SourceRevision {
  return {
    source_revision_ref: `revision-${sourceId}`,
    source_id: sourceId,
    source_namespace_id: `namespace-${sourceId}`,
    source_owner_system_id: "owner-system",
    source_owner_generation: "owner-generation-1",
    ownership_mode: "immutable_import",
    content_sha256: contentSha,
    object_residency_key_digest: SHA_B,
    normalized_artifact_ref: `normalized-${sourceId}`,
    captured_at: "2026-10-01T00:00:00.000Z",
    quality_state: "standard",
    purge_state: "LIVE",
  };
}

function copy(
  projectId: string,
  sourceId: string,
  target: ManagedTargetManifestInput["target"],
): ManagedRequiredProjectRevisionCopy {
  return {
    assignment_revision: 1,
    project_id: projectId,
    project_generation: 1,
    project_owner_principal_ref: `owner-${projectId}`,
    project_owner_deployment_generation: "deployment-1",
    namespace: target.namespace,
    managed_instance_id: target.managed_instance_id,
    managed_generation: target.managed_generation,
    target_profile_identity_sha256: target.target_profile_identity_sha256,
    project_membership_id: `project:${projectId}:generation:1`,
    source_id: sourceId,
    source_revision_ref: `revision-${sourceId}`,
    source_head_revision_ref: `revision-${sourceId}`,
    source_namespace_id: `namespace-${sourceId}`,
    source_owner_system_id: "owner-system",
    source_ownership_mode: "immutable_import",
    source_owner_generation: "owner-generation-1",
    source_ownership_record_revision: 1,
    source_owner_status: "ACTIVE",
    source_admission_policy_revision: 1,
    source_admission_policy_source_class: "document",
    source_admission_decision_source_class: "document",
    source_class: "document",
    source_revision_content_sha256: SHA_A,
    normalized_artifact_ref: `normalized-${sourceId}`,
    purge_state: "LIVE",
    admission_decision: "ADMITTED",
    admission_decision_receipt_ref: `decision-${sourceId}`,
    admission_decision_sha256: SHA_B,
    admission_decision_expires_at: null,
    admission_disclosure_ceiling: "private",
    project_owner_read_policy_ref: `read-${projectId}`,
    project_owner_read_policy_generation: 1,
    project_owner_read_policy_state: "ACTIVE",
    project_owner_read_policy_disclosure_ceiling: "private",
    project_owner_read_policy_expires_at: OWNER_EXPIRY,
    membership_generation: 1,
    membership_role: "selected",
    membership_valid_from: "2026-01-01T00:00:00.000Z",
    membership_valid_to: null,
  };
}

function operationBudget(subrequests = 1) {
  return {
    protocol: "eliotr.managed-target-operation-budget.v1" as const,
    subrequest_upper_bound: subrequests,
    cpu_upper_bound_ms: 500,
    input_bytes_upper_bound: 4_096,
  };
}

class MemoryImmutableStore {
  public readonly objects = new Map<string, string>();
  public readonly putKeys: string[] = [];
  public readonly store: EvidenceObjectStore;

  public constructor() {
    const objects = this.objects;
    const putKeys = this.putKeys;
    this.store = {
      async putImmutable(write): Promise<ImmutableObjectReceipt> {
        putKeys.push(write.key);
        const bytes = new Uint8Array(await new Response(write.body).arrayBuffer());
        const body = new TextDecoder().decode(bytes);
        const digest = await projectionSha256Utf8(body);
        if (digest !== write.expected_sha256 || bytes.byteLength !== write.expected_size_bytes) {
          throw new Error("memory store received bytes outside the immutable write receipt");
        }
        const previous = objects.get(write.key);
        if (previous !== undefined && previous !== body) throw new Error("immutable key collision");
        objects.set(write.key, body);
        return {
          key: write.key,
          expected_sha256: write.expected_sha256,
          readback_sha256: digest,
          size_bytes: bytes.byteLength,
          etag: `etag-${digest.slice(0, 12)}`,
          existed_identically: previous !== undefined,
        };
      },
      async putResidencyObject() { throw new Error("manifest assembly cannot write canonical residency bytes"); },
      async open(key: string) {
        const body = objects.get(key);
        if (body === undefined) return null;
        const bytes = new TextEncoder().encode(body);
        return { size: bytes.byteLength, body: new Response(bytes).body } as NonNullable<Awaited<ReturnType<EvidenceObjectStore["open"]>>>;
      },
      async deleteForErasure() { throw new Error("manifest assembly cannot invoke erasure deletion"); },
    } as EvidenceObjectStore;
  }
}

function shadowFence(overrides: Partial<ManagedTargetManifestShadowFence> = {}): ManagedTargetManifestShadowFence {
  return {
    registry_revision: null,
    registry_sha256: null,
    active_head_generation: null,
    generation_state: "UNDECLARED",
    generation_profile_identity_sha256: null,
    expected_item_count: null,
    ...overrides,
  };
}

async function setup(
  sourceRows: readonly { readonly project_id: string; readonly source_id: string }[],
  options: {
    readonly accountTier?: "FREE" | "PAID";
    readonly maxFiles?: number;
    readonly shadow?: ManagedTargetManifestShadowFence;
    readonly unavailableCapacity?: boolean;
    readonly profileReadback?: AiSearchInstanceProfile;
  } = {},
) {
  const targetProfile = {
    ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
    index_method: { ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE.index_method },
    metadata_fields: [...AI_SEARCH_PRIMARY_PROJECTION_PROFILE.metadata_fields].sort(),
  } as AiSearchInstanceProfile;
  const targetProfileIdentity = await aiSearchPhysicalProfileDigest(targetProfile);
  const target = {
    namespace: "eliot",
    managed_instance_id: targetProfile.id,
    managed_generation: targetProfile.generation,
    target_profile_identity_sha256: targetProfileIdentity,
  };
  const profile: ManagedTargetManifestProfile = {
    target_profile: targetProfile,
    projection_profile: {
      projector_profile: "structural-markdown-v1",
      managed_instance_id: targetProfile.id,
      managed_generation: target.managed_generation,
      managed_generation_active: false,
      maximum_markdown_bytes: 4096,
      maximum_synchronous_items: 64,
      target_item_utf8_bytes: 1024,
      maximum_item_utf8_bytes: 4096,
      managed_poll_interval_ms: 1000,
      managed_timeout_ms: 30000,
    },
    copy_layout: MANAGED_TARGET_MANIFEST_COPY_LAYOUT,
  };
  const rows = sourceRows.map((row) => copy(row.project_id, row.source_id, target));
  let pageReads = 0;
  let authorityReads = 0;
  let canonicalReads = 0;
  let copyMapReads = 0;
  const store = new MemoryImmutableStore();
  const readRowsAfter = (after: string | null, limit: number) => {
    const ordered = [...rows].sort((left, right) => left.project_id.localeCompare(right.project_id));
    const start = after === null ? 0 : ordered.findIndex((row) => row.project_id > after);
    const selected = ordered.slice(start < 0 ? ordered.length : start, (start < 0 ? ordered.length : start) + limit);
    return selected;
  };
  const input: ManagedTargetManifestInput = {
    target,
    execution_id: "manifest-test-execution",
    clock: () => Date.parse(AS_OF),
    as_of: AS_OF,
    profile,
    assignment_fence: {
      async readPage({ after_project_id, limit }) {
        const projects = [...new Map(rows.map((row) => [row.project_id, row])).values()]
          .sort((left, right) => left.project_id.localeCompare(right.project_id))
          .filter((row) => after_project_id === null || row.project_id > after_project_id)
          .slice(0, limit)
          .map((row) => ({
            assignment_revision: 1,
            project_id: row.project_id,
            project_membership_generation: 1,
            project_owner_principal_ref: `owner-${row.project_id}`,
            current_project_owner_principal_ref: `owner-${row.project_id}`,
            project_owner_deployment_generation: "deployment-1",
            namespace: target.namespace,
            managed_instance_id: target.managed_instance_id,
            managed_generation: target.managed_generation,
            target_profile_identity_sha256: target.target_profile_identity_sha256,
            project_exists: true,
          }));
        const last = projects.at(-1);
        return {
          rows: projects,
          next_cursor: projects.length === limit ? last?.project_id ?? null : null,
          budget: operationBudget(),
        };
      },
    },
    required_set: {
      async readPage({ after, limit }) {
        pageReads += 1;
        const selected = readRowsAfter(after?.project_id ?? null, limit);
        const last = selected.at(-1);
        return {
          page: {
            rows: selected,
            next_cursor: selected.length === limit && last !== undefined
              ? {
                  project_id: last.project_id,
                  source_id: last.source_id,
                  membership_generation: last.membership_generation,
                  source_revision_ref: last.source_revision_ref,
                }
              : null,
          },
          budget: operationBudget(),
        };
      },
    },
    shadow_authority: {
      async read() {
        return { fence: shadowFence(options.shadow ?? {}), budget: operationBudget() };
      },
    },
    capacity_authority: {
      async read() {
        if (options.unavailableCapacity) return {
          receipt: null,
          profile_readback: options.profileReadback ?? targetProfile,
          profile_authority_ref: "fixture:current-ai-search-profile-readback",
          profile_authority_sha256: SHA_B,
          profile_readback_checked_at: AS_OF,
          budget: operationBudget(),
        };
        const accountTier = options.accountTier ?? "PAID";
        return {
          receipt: {
            protocol: "eliotr.managed-target-provider-capacity.v1",
            account_tier: accountTier,
            account_authority_ref: `fixture:verified-cloudflare-${accountTier.toLowerCase()}-tier`,
            account_authority_sha256: SHA_A,
            checked_at: AS_OF,
            max_files_per_instance: options.maxFiles ?? (accountTier === "FREE" ? MANAGED_TARGET_FREE_FILE_LIMIT : MANAGED_TARGET_HYBRID_FILE_LIMIT),
            documentation_modified_on: "2026-10-01",
          },
          profile_readback: options.profileReadback ?? targetProfile,
          profile_authority_ref: "fixture:current-ai-search-profile-readback",
          profile_authority_sha256: SHA_B,
          profile_readback_checked_at: AS_OF,
          budget: operationBudget(),
        };
      },
    },
    documents: {
      async readAuthority({ copy: projectCopy }) {
        authorityReads += 1;
        return {
          authority: {
            source_revision: sourceRevision(projectCopy.source_id, projectCopy.source_revision_content_sha256),
            source_title: `Title ${projectCopy.source_id}`,
            source_class: "document",
            instruction_taint: "DATA_ONLY",
          },
          budget: operationBudget(),
        };
      },
    },
    canonical_projection: {
      async readCanonicalSource({ copy: projectCopy, source_authority: sourceAuthority, profile: exactProfile }) {
        canonicalReads += 1;
        const projectorProfileSha = await projectionDigest({
          projector_profile: exactProfile.projection_profile.projector_profile,
          target_item_utf8_bytes: exactProfile.projection_profile.target_item_utf8_bytes,
          maximum_item_utf8_bytes: exactProfile.projection_profile.maximum_item_utf8_bytes,
        });
        const canonicalGeneration = `canonical-${projectCopy.source_id}`;
        const prefix = await sourceResidencyWorkPrefix(projectCopy.source_revision_ref);
        const sections = [{
          canonical_section_id: `section-${projectCopy.source_id}`,
          content_sha256: projectCopy.source_revision_content_sha256,
          normalized_start_byte: 0,
          normalized_end_byte: 1,
          canonical_body_ref: `${prefix}${canonicalGeneration}/items/${projectCopy.source_id}.json`,
          canonical_body_sha256: SHA_B,
        }];
        const receipt: CanonicalSourceProjectionReceipt = {
          protocol: "eliotr.canonical-source-projection.v1",
          source_revision_ref: projectCopy.source_revision_ref,
          complete_residency_key_sha256: sourceAuthority.source_revision.object_residency_key_digest,
          projector_profile_sha256: projectorProfileSha,
          canonical_projection_generation: canonicalGeneration,
          canonical_source_ref: `${prefix}${canonicalGeneration}/manifests/source.json`,
          canonical_source_sha256: SHA_B,
          canonical_section_count: sections.length,
          canonical_section_set_sha256: await projectionDigest({ protocol: "eliotr.canonical-section-set.v1", sections }),
          sections,
        };
        return { receipt, budget: operationBudget() };
      },
      async readProjectCopy({ target: exactTarget, copy: projectCopy, canonical_source: source }) {
        copyMapReads += 1;
        const items = source.sections.map((section) => ({
          item_key: `item-${projectCopy.project_id}-${projectCopy.source_id}`,
          canonical_section_id: section.canonical_section_id,
          content_sha256: section.content_sha256,
          canonical_body_ref: section.canonical_body_ref,
          canonical_body_sha256: section.canonical_body_sha256,
        }));
        const itemSetSha = await providerItemSetDigest(items);
        const receipt: ManagedProjectCopyMapReceipt = {
          protocol: "eliotr.managed-project-copy-map.v1",
          source_revision_ref: projectCopy.source_revision_ref,
          complete_residency_key_sha256: source.complete_residency_key_sha256,
          target: exactTarget,
          project_id: projectCopy.project_id,
          project_membership_id: projectCopy.project_membership_id,
          membership_generation: projectCopy.membership_generation,
          canonical_source_ref: source.canonical_source_ref,
          canonical_source_sha256: source.canonical_source_sha256,
          provider_copy_count: 1,
          provider_copy_set_sha256: await providerCopySetDigest({
            target: exactTarget,
            project_id: projectCopy.project_id,
            project_membership_id: projectCopy.project_membership_id,
            membership_generation: projectCopy.membership_generation,
            provider_item_set_sha256: itemSetSha,
            provider_item_count: items.length,
          }),
          provider_item_count: items.length,
          provider_item_set_sha256: itemSetSha,
          items,
        };
        return { receipt, budget: operationBudget() };
      },
    },
    work_store: store.store,
    work_index: {
      async list({ prefix, cursor, limit }) {
        const all = [...store.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
        const start = cursor === null ? 0 : all.findIndex((key) => key > cursor);
        const from = start < 0 ? all.length : start;
        const objects = all.slice(from, from + limit).map((key) => ({ key }));
        const truncated = from + objects.length < all.length;
        return { objects, truncated, cursor: truncated ? objects.at(-1)?.key ?? null : null };
      },
      async deleteKeys(keys) { for (const key of keys) store.objects.delete(key); },
    },
  };
  return { input, store, counters: { get pageReads() { return pageReads; }, get authorityReads() { return authorityReads; }, get canonicalReads() { return canonicalReads; }, get copyMapReads() { return copyMapReads; } } };
}

async function runToReady(input: ManagedTargetManifestInput, maximumSteps = 100): Promise<Awaited<ReturnType<typeof advanceManagedTargetManifest>>> {
  let result = await advanceManagedTargetManifest(input);
  if (result.budget.operation_upper_bound > 16 || result.budget.cpu_upper_bound_ms >= 30_000) {
    throw new Error("manifest step exceeded its fixed operation or CPU ceiling");
  }
  for (let step = 0; result.status === "CONTINUE" && step < maximumSteps; step += 1) {
    if (result.continuation === null) throw new Error("continuation receipt is missing");
    result = await advanceManagedTargetManifest({ ...input, continuation: result.continuation });
    if (result.budget.operation_upper_bound > 16 || result.budget.cpu_upper_bound_ms >= 30_000) {
      throw new Error("manifest step exceeded its fixed operation or CPU ceiling");
    }
  }
  if (result.status !== "READY_FOR_FINALIZATION") throw new Error("manifest did not reach its bounded ready candidate");
  return result;
}

describe("managed target manifest continuation", () => {
  it("resumes exact Work checkpoints and reuses a completed copy without reprojection", async () => {
    const state = await setup([{ project_id: "project-a", source_id: "source-a" }]);
    let step = await advanceManagedTargetManifest(state.input);
    const seenBudgets = [step.budget];
    while (step.phase !== "BUILD_SCAN") {
      if (step.continuation === null) throw new Error("manifest ended before its build scan");
      step = await advanceManagedTargetManifest({ ...state.input, continuation: step.continuation });
      seenBudgets.push(step.budget);
    }
    if (step.continuation === null) throw new Error("build continuation is missing");
    const buildInput = { ...state.input, continuation: step.continuation };
    const firstBuild = await advanceManagedTargetManifest(buildInput);
    seenBudgets.push(firstBuild.budget);
    const copyReadCount = state.counters.copyMapReads;
    const canonicalReadCount = state.counters.canonicalReads;
    const copyObjectPuts = state.store.putKeys.filter((key) => key.includes("/copies/")).length;

    const restartedBuild = await advanceManagedTargetManifest(buildInput);
    seenBudgets.push(restartedBuild.budget);
    expect(state.counters.copyMapReads).toBe(copyReadCount);
    expect(state.counters.canonicalReads).toBe(canonicalReadCount);
    expect(state.store.putKeys.filter((key) => key.includes("/copies/")).length).toBe(copyObjectPuts);

    if (restartedBuild.continuation === null) throw new Error("replayed build continuation is missing");
    const ready = await runToReady({ ...state.input, continuation: restartedBuild.continuation });
    seenBudgets.push(ready.budget);
    expect(ready.candidate).toMatchObject({
      protocol: "eliotr.managed-target-desired-items.v2",
      desired_item_count: 1,
      finalization_state: "REQUIRES_HELD_WRITER_DRAIN_AND_EXPECTED_HEAD_CAS",
    });
    expect(seenBudgets.every((budget) => budget.operation_upper_bound <= 16 && budget.cpu_upper_bound_ms < 30_000)).toBe(true);
  });

  it("fails closed on missing trusted capacity before required-set reads or Work writes", async () => {
    const state = await setup([{ project_id: "project-a", source_id: "source-a" }], { unavailableCapacity: true });
    await expect(advanceManagedTargetManifest(state.input)).rejects.toMatchObject({
      code: "MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_UNAVAILABLE",
    });
    expect(state.counters.pageReads).toBe(0);
    expect(state.store.objects.size).toBe(0);
  });

  it("rejects a fresh profile readback whose physical index method differs from assignment", async () => {
    const targetProfile = {
      ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
      index_method: {
        ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE.index_method,
        keyword: !AI_SEARCH_PRIMARY_PROJECTION_PROFILE.index_method.keyword,
      },
    } as AiSearchInstanceProfile;
    const state = await setup([{ project_id: "project-a", source_id: "source-a" }], {
      profileReadback: targetProfile,
    });
    await expect(advanceManagedTargetManifest(state.input)).rejects.toMatchObject({
      code: "MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_INVALID",
    });
    expect(state.counters.pageReads).toBe(0);
    expect(state.store.objects.size).toBe(0);
  });

  it("rejects the exact 102400-row ceiling without a terminal empty page proof", async () => {
    const state = await setup([{ project_id: "project-a", source_id: "source-a" }]);
    const fence = {
      assignment_heads_sha256: SHA_A,
      assigned_project_count: 102_400,
      stale_assignment_count: 0,
      profile_mismatch_count: 0,
    };
    const scan = await initialManagedTargetManifestScan(state.input.target, AS_OF, fence);
    const atLimit = {
      ...scan,
      pages: 400,
      count: 102_400,
      after: {
        project_id: "project-z",
        source_id: "source-z",
        membership_generation: 1,
        source_revision_ref: "revision-z",
      },
    };
    const terminal = await foldManagedTargetManifestPage(
      atLimit,
      { rows: [], next_cursor: null },
      state.input.target,
      AS_OF,
    );
    expect(terminal.state.pages).toBe(401);
    await expect(foldManagedTargetManifestPage(
      atLimit,
      { rows: [copy("project-z", "source-z", state.input.target)], next_cursor: null },
      state.input.target,
      AS_OF,
    )).rejects.toMatchObject({ code: "MANAGED_REQUIRED_SET_BOUNDS_EXCEEDED" });
  });

  it("distinguishes physical identity from exact legacy assignment hashes", async () => {
    const state = await setup([]);
    const profile = state.input.profile;
    const logicalTarget = {
      ...state.input.target,
      managed_generation: "logical-generation-b",
      target_profile_identity_sha256: await aiSearchPhysicalProfileDigest(profile.target_profile),
    };
    const logicalProfile: ManagedTargetManifestProfile = {
      ...profile,
      projection_profile: { ...profile.projection_profile, managed_generation: "logical-generation-b" },
    };
    const physical = await validateManifestProfile({ target: logicalTarget, profile: logicalProfile });
    expect(physical.target_profile_sha256).toBe(logicalTarget.target_profile_identity_sha256);
    expect(() => validateShadowFence(shadowFence({
      registry_revision: 1,
      registry_sha256: SHA_A,
      generation_state: "SHADOW_BUILDING",
      generation_profile_identity_sha256: physical.target_profile_sha256,
      expected_item_count: 0,
    }), logicalTarget, physical.target_profile_sha256)).not.toThrow();

    const legacyHash = await projectionDigest(profile.target_profile);
    const legacyTarget = { ...state.input.target, target_profile_identity_sha256: legacyHash };
    await expect(validateManifestProfile({ target: legacyTarget, profile })).resolves.toMatchObject({
      target_profile_sha256: await aiSearchPhysicalProfileDigest(profile.target_profile),
    });
    await expect(validateManifestProfile({
      target: { ...legacyTarget, managed_generation: "logical-generation-b" },
      profile: logicalProfile,
    })).rejects.toMatchObject({ code: "MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH" });
  });

  it("keeps documented file ceilings separate from account tier authority", async () => {
    const state = await setup([]);
    const profile = state.input.profile.target_profile;
    const free = await validateManagedTargetProviderCapacityReceipt({
      protocol: "eliotr.managed-target-provider-capacity.v1",
      account_tier: "FREE",
      account_authority_ref: "fixture:verified-free-tier",
      account_authority_sha256: SHA_A,
      checked_at: AS_OF,
      max_files_per_instance: MANAGED_TARGET_FREE_FILE_LIMIT,
      documentation_modified_on: "2026-10-01",
    }, profile);
    expect(free.max_files_per_instance).toBe(100_000);
    expect(() => assertManagedTargetProviderCapacity(free, profile, 100_000, 1)).toThrow("TARGET_CAPACITY_EXCEEDED");
    await expect(validateManagedTargetProviderCapacityReceipt({
      ...free,
      max_files_per_instance: MANAGED_TARGET_HYBRID_FILE_LIMIT,
    }, profile)).rejects.toThrow("CAPACITY_AUTHORITY_INVALID");
  });
});
