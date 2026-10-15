import type { SourceRevision } from "@eliotr/contracts";
import type { AiSearchInstanceProfile, EvidenceObjectStore, ImmutableObjectReceipt } from "@eliotr/platform-cloudflare";
import { canonicalProjectionJson, projectionSha256Utf8, stableProjectionId, utf8ProjectionBytes } from "./canonical.js";
import { AI_SEARCH_PRIMARY_PROJECTION_PROFILE } from "./ai-search-primary-profile.js";
import { aiSearchPhysicalProfileDigest } from "./ai-search-profile-identity-digest.js";
import type { ManagedTargetSelectionV2 } from "./managed-target-assignment.js";
import {
  advanceManagedTargetManifest,
  MANAGED_TARGET_MANIFEST_COPY_LAYOUT,
  type ManagedTargetManifestInput,
  type ManagedTargetManifestProfile,
  type ManagedTargetManifestShadowFence,
} from "./managed-target-manifest.js";
import type { ManagedTargetManifestOperationBudgetReceipt } from "./managed-target-manifest-contract.js";
import {
  MANAGED_TARGET_FREE_FILE_LIMIT,
  MANAGED_TARGET_HYBRID_FILE_LIMIT,
} from "./managed-target-manifest-fragments.js";
import type { ManagedRequiredProjectRevisionCopy } from "./managed-required-set.js";
import type {
  CanonicalSourceProjectionReceipt,
  ManagedProjectCopyMapSetReceiptV1,
  ManagedProjectCopyMapSetReceiptV2,
  ManagedProjectCopyTargetReceipt,
  ManagedTargetRequiredSetCopyMapSetReceiptV3,
  ProjectCopyMembershipCopyV2,
  ProjectCopyScopeV2,
  TargetRequiredSetCopyAuthorityV3,
} from "./types.js";
import { createR2CanonicalSourceProjectionWriter } from "./work-store.js";

export const AS_OF = "2026-10-14T16:00:00.000Z";
const OWNER_EXPIRY = "2027-01-01T00:00:00.000Z";
export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);

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

export function copy(
  projectId: string,
  sourceId: string,
  target: ManagedTargetManifestInput["target"],
): ManagedRequiredProjectRevisionCopy {
  return {
    assignment_revision: 1,
    assignment_decision_version: 1,
    assignment_selection_mode: "EXACT_GENERATION_V1",
    assignment_product_alias: null,
    assignment_managed_generation: target.managed_generation,
    assignment_target_profile_identity_sha256: target.target_profile_identity_sha256,
    project_id: projectId,
    project_generation: 1,
    project_default_disclosure: "private",
    project_retention_policy_ref: `retention-${projectId}`,
    project_default_source_policy_ref: `source-policy-${projectId}`,
    project_default_model_profile_ref: `model-profile-${projectId}`,
    project_default_depth_profile_ref: `depth-profile-${projectId}`,
    project_owner_principal_ref: `owner-${projectId}`,
    project_owner_deployment_generation: "deployment-1",
    namespace: target.namespace,
    managed_instance_id: target.managed_instance_id,
    managed_generation: target.managed_generation,
    target_profile_identity_sha256: target.target_profile_identity_sha256,
    project_membership_id: `project:${projectId}:generation:1`,
    stable_project_membership_id: `stable-membership-${projectId}-${sourceId}`,
    legacy_project_membership_id: `project:${projectId}:generation:1`,
    project_membership_identity_version: 1,
    membership_id: JSON.stringify([projectId, sourceId]),
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
    membership_revision: 1,
    project_membership_generation: 1,
    membership_role: "selected",
    membership_valid_from: "2026-01-01T00:00:00.000Z",
    membership_valid_to: null,
  };
}

function normalizedMarkdown(sourceId: string): string {
  return `# Title ${sourceId}\n\nCanonical source body for ${sourceId}.`;
}

/** Synthetic local adapter receipt for deterministic fixtures; not production CPU/cost qualification. */
function operationBudget(subrequests = 1, inputBytes = 4_096) {
  return {
    protocol: "eliotr.managed-target-operation-budget.v1" as const,
    subrequest_upper_bound: subrequests,
    cpu_upper_bound_ms: 100,
    input_bytes_upper_bound: inputBytes,
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

export function shadowFence(overrides: Partial<ManagedTargetManifestShadowFence> = {}): ManagedTargetManifestShadowFence {
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

export async function setup(
  sourceRows: readonly {
    readonly project_id: string;
    readonly source_id: string;
    readonly membership_identity_version?: 1 | 2;
    readonly membership_generation?: number;
    readonly membership_revision?: number;
    readonly project_membership_generation?: number;
  }[],
  options: {
    readonly accountTier?: "FREE" | "PAID";
    readonly maxFiles?: number;
    readonly shadow?: ManagedTargetManifestShadowFence;
    readonly unavailableCapacity?: boolean;
    readonly profileReadback?: AiSearchInstanceProfile;
    readonly copyLayout?: "PROJECT_COPY_V1" | "PROJECT_COPY_V2";
    readonly targetSelection?: Omit<ManagedTargetSelectionV2, "target">;
    readonly logicalGeneration?: string;
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
    managed_generation: options.logicalGeneration ?? targetProfile.generation,
    target_profile_identity_sha256: targetProfileIdentity,
  };
  const targetSelection: ManagedTargetSelectionV2 | undefined = options.targetSelection === undefined
    ? undefined
    : { ...options.targetSelection, target };
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
    copy_layout: options.copyLayout ?? MANAGED_TARGET_MANIFEST_COPY_LAYOUT,
  };
  const contentDigests = new Map<string, string>();
  for (const row of sourceRows) {
    if (!contentDigests.has(row.source_id)) {
      contentDigests.set(row.source_id, await projectionSha256Utf8(normalizedMarkdown(row.source_id)));
    }
  }
  const rows = await Promise.all(sourceRows.map(async (row) => {
    const membershipGeneration = row.membership_generation ?? 1;
    const legacyMembershipId = `project:${row.project_id}:generation:${membershipGeneration}`;
    const stableMembershipId = await stableProjectionId(
      "project-membership",
      JSON.stringify([row.project_id, row.source_id]),
    );
    const base = {
      ...copy(row.project_id, row.source_id, target),
      project_membership_id: legacyMembershipId,
      stable_project_membership_id: stableMembershipId,
      legacy_project_membership_id: legacyMembershipId,
      membership_generation: membershipGeneration,
      source_revision_content_sha256: contentDigests.get(row.source_id) ?? SHA_A,
      project_membership_generation: row.project_membership_generation ?? 1,
    };
    if (targetSelection === undefined || row.membership_identity_version === 1) return base;
    return {
      ...base,
      assignment_decision_version: 2 as const,
      assignment_selection_mode: "STABLE_PHYSICAL_PROFILE_V2" as const,
      assignment_product_alias: "primary" as const,
      assignment_managed_generation: "older-logical-generation",
      assignment_target_profile_identity_sha256: target.target_profile_identity_sha256,
      project_membership_id: stableMembershipId,
      stable_project_membership_id: stableMembershipId,
      legacy_project_membership_id: null,
      project_membership_identity_version: 2 as const,
      membership_id: JSON.stringify([row.project_id, row.source_id]),
      membership_revision: row.membership_revision ?? 1,
    };
  }));
  let pageReads = 0;
  let authorityReads = 0;
  let normalizedReads = 0;
  let canonicalReads = 0;
  let copyMapReads = 0;
  const store = new MemoryImmutableStore();
  const writer = createR2CanonicalSourceProjectionWriter({
    work_bucket: {} as R2Bucket,
    object_store: store.store,
  });
  interface LocalWriterBudgetFields {
    readonly operation_budget_remaining: number;
    readonly subrequest_budget_remaining: number;
    readonly cpu_budget_remaining_ms: number;
    readonly input_bytes_budget_remaining: number;
  }
  type V1MapInput = {
    readonly canonical: CanonicalSourceProjectionReceipt;
    readonly target: ManagedProjectCopyTargetReceipt;
    readonly memberships: readonly {
      readonly project_id: string;
      readonly project_membership_id: string;
      readonly membership_generation: number;
    }[];
  } & LocalWriterBudgetFields;
  type V2MapInput = {
    readonly canonical: CanonicalSourceProjectionReceipt;
    readonly target: ManagedProjectCopyTargetReceipt;
    readonly scope: ProjectCopyScopeV2;
  } & LocalWriterBudgetFields;
  type V3MapInput = {
    readonly canonical: CanonicalSourceProjectionReceipt;
    readonly target: ManagedProjectCopyTargetReceipt;
    readonly authority: TargetRequiredSetCopyAuthorityV3;
    readonly copies: readonly ProjectCopyMembershipCopyV2[];
  } & LocalWriterBudgetFields;
  type V1MapResult = {
    readonly receipt: ManagedProjectCopyMapSetReceiptV1;
    readonly budget: ManagedTargetManifestOperationBudgetReceipt;
  };
  type V2MapResult = {
    readonly receipt: ManagedProjectCopyMapSetReceiptV2;
    readonly budget: ManagedTargetManifestOperationBudgetReceipt;
  };
  type V3MapResult = {
    readonly receipt: ManagedTargetRequiredSetCopyMapSetReceiptV3;
    readonly budget: ManagedTargetManifestOperationBudgetReceipt;
  };
  async function mapProjectCopies(input: V1MapInput): Promise<V1MapResult>;
  async function mapProjectCopies(input: V2MapInput): Promise<V2MapResult>;
  async function mapProjectCopies(input: V1MapInput | V2MapInput): Promise<V1MapResult | V2MapResult> {
    if ("scope" in input) {
      copyMapReads += input.scope.copies.length;
      const receipt = await writer.mapProjectCopies({ canonical: input.canonical, target: input.target, scope: input.scope });
      const inputBytes = utf8ProjectionBytes(canonicalProjectionJson({
        canonical: input.canonical,
        target: input.target,
        scope: input.scope,
      })).byteLength;
      return {
        receipt,
        budget: Object.freeze({
          protocol: "eliotr.managed-target-operation-budget.v1",
          subrequest_upper_bound: receipt.resource_bounds.copy_map_r2_subrequest_bound,
          // Synthetic deterministic fixture envelope; never a production CPU measurement.
          cpu_upper_bound_ms: 1,
          input_bytes_upper_bound: inputBytes,
        }),
      };
    }
    copyMapReads += input.memberships.length;
    const receipt = await writer.mapProjectCopies({
      canonical: input.canonical,
      target: input.target,
      memberships: input.memberships,
    });
    return {
      receipt,
      budget: operationBudget(
        receipt.resource_bounds.copy_map_r2_subrequest_bound,
        input.memberships.length * 4 * 1024,
      ),
    };
  }
  async function mapTargetRequiredSetCopies(input: V3MapInput): Promise<V3MapResult> {
    copyMapReads += input.copies.length;
    const receipt = await writer.mapTargetRequiredSetCopies({
      canonical: input.canonical,
      target: input.target,
      authority: input.authority,
      copies: input.copies,
    });
    const inputBytes = utf8ProjectionBytes(canonicalProjectionJson({
      canonical: input.canonical,
      target: input.target,
      authority: input.authority,
      copies: input.copies,
    })).byteLength;
    return {
      receipt,
      budget: Object.freeze({
        protocol: "eliotr.managed-target-operation-budget.v1",
        subrequest_upper_bound: receipt.resource_bounds.copy_map_r2_subrequest_bound,
        // Synthetic deterministic fixture envelope; never a production CPU measurement.
        cpu_upper_bound_ms: 1,
        input_bytes_upper_bound: inputBytes,
      }),
    };
  }
  const readRowsAfter = (after: string | null, limit: number) => {
    const ordered = [...rows].sort((left, right) => left.project_id.localeCompare(right.project_id));
    const start = after === null ? 0 : ordered.findIndex((row) => row.project_id > after);
    const selected = ordered.slice(start < 0 ? ordered.length : start, (start < 0 ? ordered.length : start) + limit);
    return selected;
  };
  const input: ManagedTargetManifestInput = {
    target,
    ...(targetSelection === undefined ? {} : { target_selection: targetSelection }),
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
            assignment_revision: row.assignment_revision,
            assignment_decision_version: row.assignment_decision_version,
            assignment_selection_mode: row.assignment_selection_mode,
            assignment_product_alias: row.assignment_product_alias,
            assignment_managed_generation: row.assignment_managed_generation,
            project_id: row.project_id,
            project_membership_generation: row.project_membership_generation,
            project_owner_principal_ref: `owner-${row.project_id}`,
            current_project_owner_principal_ref: `owner-${row.project_id}`,
            project_owner_deployment_generation: "deployment-1",
            namespace: row.namespace,
            managed_instance_id: row.managed_instance_id,
            managed_generation: row.managed_generation,
            target_profile_identity_sha256: row.target_profile_identity_sha256,
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
              ...(targetSelection === undefined
                ? { membership_generation: last.membership_generation }
                : { membership_revision: last.membership_revision }),
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
      async readAuthorityBatch({ copies }) {
        authorityReads += copies.length;
        return {
          authorities: copies.map((projectCopy) => ({
            source_revision: sourceRevision(projectCopy.source_id, projectCopy.source_revision_content_sha256),
            source_title: `Title ${projectCopy.source_id}`,
            source_class: "document",
            instruction_taint: "DATA_ONLY" as const,
          })),
          budget: operationBudget(),
        };
      },
      async readNormalizedContent({ copy: projectCopy, source_authority: sourceAuthority }) {
        normalizedReads += 1;
        const markdown = normalizedMarkdown(projectCopy.source_id);
        const bytes = new TextEncoder().encode(markdown);
        return {
          normalized_markdown: markdown,
          normalized_object_ref: sourceAuthority.source_revision.normalized_artifact_ref ?? `normalized-${projectCopy.source_id}`,
          readback_sha256: await projectionSha256Utf8(markdown),
          size_bytes: bytes.byteLength,
          budget: operationBudget(1, bytes.byteLength),
        };
      },
    },
    canonical_projection: {
      async projectCanonicalSource(input) {
        canonicalReads += 1;
        const receipt = await writer.projectCanonicalSource(input);
        const inputBytes = utf8ProjectionBytes(canonicalProjectionJson({
          source: input.source,
          profile: input.profile,
          normalized_markdown: input.normalized_markdown,
        })).byteLength;
        return {
          receipt,
          budget: operationBudget(
            receipt.resource_bounds.canonical_r2_subrequest_bound - receipt.resource_bounds.source_content_r2_get_bound,
            inputBytes,
          ),
        };
      },
      mapProjectCopies,
      mapTargetRequiredSetCopies,
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
  return { input, store, counters: { get pageReads() { return pageReads; }, get authorityReads() { return authorityReads; }, get normalizedReads() { return normalizedReads; }, get canonicalReads() { return canonicalReads; }, get copyMapReads() { return copyMapReads; } } };
}

export async function runToReady(input: ManagedTargetManifestInput, maximumSteps = 100): Promise<Awaited<ReturnType<typeof advanceManagedTargetManifest>>> {
  let result = await advanceManagedTargetManifest(input);
  if (result.budget.operation_upper_bound > 386 || result.budget.cpu_upper_bound_ms >= 30_000) {
    throw new Error("manifest step exceeded its fixed operation or CPU ceiling");
  }
  for (let step = 0; result.status === "CONTINUE" && step < maximumSteps; step += 1) {
    if (result.continuation === null) throw new Error("continuation receipt is missing");
    result = await advanceManagedTargetManifest({ ...input, continuation: result.continuation });
    if (result.budget.operation_upper_bound > 386 || result.budget.cpu_upper_bound_ms >= 30_000) {
      throw new Error("manifest step exceeded its fixed operation or CPU ceiling");
    }
  }
  if (result.status !== "READY_FOR_FINALIZATION") throw new Error("manifest did not reach its bounded ready candidate");
  return result;
}
