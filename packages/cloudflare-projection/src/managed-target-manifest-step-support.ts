import type { EvidenceObjectStore, ImmutableObjectReceipt } from "@eliotr/platform-cloudflare";
import type { ManagedTargetIdentity } from "./managed-target-assignment.js";
import type {
  ManagedTargetManifestInvocationBudget,
  ManagedTargetManifestOperationBudgetReceipt,
  ManagedTargetManifestProfile,
  ManagedTargetManifestShadowFence,
  ManagedTargetManifestShadowState,
  ManagedTargetManifestSourceAuthority,
} from "./managed-target-manifest-contract.js";
import type {
  ManagedRequiredProjectRevisionCopy,
  ManagedRequiredSetCursor,
  ManagedRequiredSetFence,
  ManagedRequiredSetReceipt,
} from "./managed-required-set.js";
import {
  canonicalProjectionJson,
  projectionDigest,
  profileIsValid,
  utf8ProjectionBytes,
} from "./canonical.js";
import { ManagedTargetManifestError, type ManagedTargetManifestErrorCode } from "./managed-target-manifest-contract.js";
import { validateOperationBudgetReceipt } from "./managed-target-manifest-fragments.js";
import {
  aiSearchPhysicalProfileDigest,
  matchAiSearchProfileIdentity,
} from "./ai-search-profile-identity-digest.js";

export const MANAGED_TARGET_MANIFEST_COPY_BATCH_SIZE = 1;
export const MANAGED_TARGET_MANIFEST_SUMMARY_PAGE_SIZE = 8;
export const MANAGED_TARGET_MANIFEST_FENCE_PAGE_SIZE = 256;
export const MANAGED_TARGET_MANIFEST_FENCE_PAGES_PER_STEP = 3;
export const MANAGED_TARGET_MANIFEST_MAX_OPERATIONS_PER_STEP = 16;
export const MANAGED_TARGET_MANIFEST_MAX_WORKFLOW_STEPS = 10_000;
export const MANAGED_TARGET_MANIFEST_LOCAL_CPU_BOUND_MS = 5_000;
export const MANAGED_TARGET_MANIFEST_ASSIGNMENT_ROW_CPU_BOUND_MS = 0.2;
export const MANAGED_TARGET_MANIFEST_MAX_COPIES = 102_400;
export const MANAGED_TARGET_MANIFEST_MAX_PAGES = 400;
export const MANAGED_TARGET_MANIFEST_MAX_TREE_NODES_PER_STEP = 96;
export const MANAGED_TARGET_MANIFEST_CHECKPOINT_SUBREQUEST_RESERVE = 2;

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export type ManifestTreeRef = {
  readonly kind: "COPY" | "INDEX";
  readonly key: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly first_copy_ordinal: number;
  readonly last_copy_ordinal: number;
  readonly copy_count: number;
  readonly item_count: number;
};

export interface ScanProgress {
  readonly scan: {
    readonly digest: string;
    readonly page_provenance_digest: string;
    readonly count: number;
    readonly pages: number;
    readonly after: ManagedRequiredSetCursor | null;
    readonly last_copy: ManagedRequiredProjectRevisionCopy | null;
  };
  readonly page_ref: string | null;
  readonly page_sha256: string | null;
  readonly page_object_sha256: string | null;
  readonly page_row_count: number;
  readonly page_offset: number;
  readonly complete: boolean;
}

export interface ManifestBudgetSummary {
  readonly step_count: number;
  readonly total_subrequest_upper_bound: number;
  readonly total_operation_upper_bound: number;
  readonly maximum_step_subrequests: number;
  readonly maximum_step_operations: number;
  readonly maximum_step_cpu_upper_bound_ms: number;
  readonly receipt_digest: string;
}

export interface FenceScanProgress {
  readonly digest: string;
  readonly page_provenance_digest: string;
  readonly assigned_project_count: number;
  readonly stale_assignment_count: number;
  readonly profile_mismatch_count: number;
  readonly pages: number;
  readonly after_project_id: string | null;
  readonly last_project_id: string | null;
  readonly complete: boolean;
}

export interface ManifestContinuationState {
  readonly protocol: "eliotr.managed-target-manifest-continuation.v1";
  readonly execution_id: string;
  readonly target: ManagedTargetIdentity;
  readonly target_profile_sha256: string;
  readonly projection_profile_sha256: string;
  readonly as_of: string;
  readonly scan_identity_sha256: string;
  readonly build_identity_sha256: string | null;
  readonly build_prefix: string;
  readonly phase: "INITIAL_FENCE_SCAN" | "BUILD_SCAN" | "VERIFY_SCAN" | "SOURCE_SUMMARY" | "FINAL_FENCE_SCAN" | "FINALIZE";
  readonly initial_fence_scan: FenceScanProgress;
  readonly final_fence_scan: FenceScanProgress | null;
  readonly initial_fence: ManagedRequiredSetFence | null;
  readonly initial_shadow_fence: ManagedTargetManifestShadowFence;
  readonly shadow_fence_sha256: string;
  readonly capacity_identity_sha256: string;
  readonly capacity_receipt_sha256: string;
  readonly capacity_limit: number;
  readonly build_scan: ScanProgress | null;
  readonly verify_scan: ScanProgress | null;
  readonly initial_required_set: ManagedRequiredSetReceipt | null;
  readonly verified_required_set: ManagedRequiredSetReceipt | null;
  readonly copy_ordinal: number;
  readonly desired_item_count: number;
  readonly desired_item_set_sha256: string;
  readonly source_authority_sha256: string;
  readonly post_source_authority_sha256: string | null;
  readonly provider_copy_count: number;
  readonly provider_copy_set_sha256: string;
  readonly provider_item_set_sha256: string;
  readonly tree_frontier: readonly (readonly ManifestTreeRef[])[];
  readonly source_summary: {
    readonly cursor: string | null;
    readonly seen_cursors: readonly string[];
    readonly last_key: string | null;
    readonly count: number;
    readonly section_count: number;
    readonly source_set_sha256: string;
    readonly section_set_sha256: string;
    readonly complete: boolean;
  };
  readonly budget_summary: ManifestBudgetSummary;
  readonly previous_continuation_ref: string | null;
  readonly previous_continuation_sha256: string | null;
}

export class ManifestInvocationBudget {
  private coreD1 = 0;
  private searchD1 = 0;
  private capacityCalls = 0;
  private capacitySubrequests = 0;
  private writerCalls = 0;
  private r2Get = 0;
  private r2Put = 0;
  private r2Readback = 0;
  private r2List = 0;
  private r2Delete = 0;
  private ownerReads = 0;
  private localCpuMs = MANAGED_TARGET_MANIFEST_LOCAL_CPU_BOUND_MS;
  private writerCpuMs = 0;
  private maxInputBytes = 0;
  private requiredRows = 0;
  private copiesProcessed = 0;
  private itemsProcessed = 0;
  private fragmentBytes = 0;

  public constructor(
    public readonly invocationIndex: number,
    private readonly clockReads: number,
    private readonly profileValidations: number,
  ) {}

  public addCoreD1(count = 1): void { this.coreD1 += count; }
  public addSearchD1(count = 1): void { this.searchD1 += count; }
  public addCapacity(budget: ManagedTargetManifestOperationBudgetReceipt): void {
    const valid = validateOperationBudgetReceipt(budget);
    this.capacityCalls += 1;
    this.capacitySubrequests += valid.subrequest_upper_bound;
    this.writerCpuMs += valid.cpu_upper_bound_ms;
    this.maxInputBytes += valid.input_bytes_upper_bound;
  }
  public addShadow(budget: ManagedTargetManifestOperationBudgetReceipt): void {
    const valid = validateOperationBudgetReceipt(budget);
    this.searchD1 += valid.subrequest_upper_bound;
    this.writerCpuMs += valid.cpu_upper_bound_ms;
    this.maxInputBytes += valid.input_bytes_upper_bound;
  }
  public addWriter(budget: ManagedTargetManifestOperationBudgetReceipt): void {
    const valid = validateOperationBudgetReceipt(budget);
    this.writerCalls += valid.subrequest_upper_bound;
    this.writerCpuMs += valid.cpu_upper_bound_ms;
    this.maxInputBytes += valid.input_bytes_upper_bound;
  }
  public addR2Get(count = 1): void { this.r2Get += count; }
  public addR2Put(count = 1): void { this.r2Put += count; }
  public addR2Readback(count = 1): void { this.r2Readback += count; }
  public addR2List(count = 1): void { this.r2List += count; }
  public addR2Delete(count = 1): void { this.r2Delete += count; }
  public addOwnerAuthorityRead(): void { this.ownerReads += 1; this.coreD1 += 1; }
  public addRequiredRows(count: number): void { this.requiredRows += count; }
  public addCopy(count = 1): void { this.copiesProcessed += count; }
  public addItems(count: number): void { this.itemsProcessed += count; }
  public addFragmentBytes(count: number): void { this.fragmentBytes = Math.max(this.fragmentBytes, count); }
  public addLocalCpu(ms: number): void { this.localCpuMs += ms; }
  public addInputBytes(count: number): void { this.maxInputBytes += count; }

  public reserveOperations(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0 || this.currentOperations() + count > MANAGED_TARGET_MANIFEST_MAX_OPERATIONS_PER_STEP) {
      throw new ManagedTargetManifestError(
        "MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED",
        "operation would cross the 16-operation invocation ceiling",
      );
    }
  }

  public remainingOperations(): number {
    return Math.max(0, MANAGED_TARGET_MANIFEST_MAX_OPERATIONS_PER_STEP - this.currentOperations());
  }

  private currentOperations(): number {
    return this.coreD1 + this.searchD1 + this.capacitySubrequests + this.writerCalls + this.r2Get + this.r2Put +
      this.r2Readback + this.r2List + this.r2Delete;
  }

  public snapshot(reserveCheckpoint = false): ManagedTargetManifestInvocationBudget {
    const subrequests = this.coreD1 + this.searchD1 + this.capacitySubrequests + this.writerCalls + this.r2Get + this.r2Put +
      this.r2Readback + this.r2List + this.r2Delete + (reserveCheckpoint ? MANAGED_TARGET_MANIFEST_CHECKPOINT_SUBREQUEST_RESERVE : 0);
    const operations = subrequests;
    const cpu = Math.ceil(this.localCpuMs + this.writerCpuMs);
    if (operations > MANAGED_TARGET_MANIFEST_MAX_OPERATIONS_PER_STEP || subrequests >= 10_000 || cpu >= 30_000 || this.maxInputBytes > 128 * 1024 * 1024) {
      throw new ManagedTargetManifestError(
        "MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED",
        "the fixed per-invocation subrequest, CPU, or input-byte upper bound is not below the deployed defaults",
      );
    }
    return Object.freeze({
      protocol: "eliotr.managed-target-manifest-invocation-budget.v1",
      invocation_index: this.invocationIndex,
      operation_limit: MANAGED_TARGET_MANIFEST_MAX_OPERATIONS_PER_STEP,
      operation_upper_bound: operations,
      subrequest_limit: 10_000,
      subrequest_upper_bound: subrequests,
      cpu_limit_ms: 30_000,
      cpu_upper_bound_ms: cpu,
      calls: Object.freeze({
        core_d1: this.coreD1,
        search_d1: this.searchD1,
        capacity_authority: this.capacityCalls,
        capacity_authority_subrequests: this.capacitySubrequests,
        writer_subrequests: this.writerCalls,
        work_r2_get: this.r2Get,
        work_r2_put: this.r2Put,
        work_r2_readback: this.r2Readback,
        work_r2_list: this.r2List,
        work_r2_delete: this.r2Delete,
        clock_reads: this.clockReads,
        profile_validations: this.profileValidations,
        owner_authority_reads: this.ownerReads,
      }),
      maximums: Object.freeze({
        required_rows: this.requiredRows,
        copies_processed: this.copiesProcessed,
        items_processed: this.itemsProcessed,
        fragment_bytes: this.fragmentBytes,
      }),
    });
  }
}

export function countedEvidenceStore(
  store: EvidenceObjectStore,
  budget: ManifestInvocationBudget,
): EvidenceObjectStore {
  return {
    async open(key: string, range?: { readonly offset: number; readonly length: number }): Promise<R2ObjectBody | null> {
      budget.reserveOperations();
      budget.addR2Get();
      return store.open(key, range);
    },
    async putImmutable(write): Promise<ImmutableObjectReceipt> {
      budget.reserveOperations(2);
      budget.addR2Put();
      budget.addR2Readback();
      return store.putImmutable(write);
    },
    async putResidencyObject(_write) {
      throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "manifest composer cannot write canonical residency objects");
    },
    async deleteForErasure() {
      throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "manifest composer cannot invoke erasure deletion");
    },
  } as EvidenceObjectStore;
}

export async function validateManifestProfile(input: {
  readonly target: ManagedTargetIdentity;
  readonly profile: ManagedTargetManifestProfile;
}): Promise<{ readonly target_profile_sha256: string; readonly projection_profile_sha256: string }> {
  const { target, profile } = input;
  if (
    profile.copy_layout !== "PROJECT_COPY_V1" ||
    profile.target_profile.id !== target.managed_instance_id ||
    profile.projection_profile.managed_instance_id !== target.managed_instance_id ||
    profile.projection_profile.managed_generation !== target.managed_generation ||
    profile.projection_profile.managed_generation_active
  ) {
    throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "projection/physical profiles do not identify this non-active logical target");
  }
  try { profileIsValid(profile.projection_profile); }
  catch (cause) { throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "projection profile failed canonical validation", cause); }
  const targetIdentityProtocol = await matchAiSearchProfileIdentity(
    profile.target_profile,
    target.target_profile_identity_sha256,
  );
  const targetProfileDigest = await aiSearchPhysicalProfileDigest(profile.target_profile);
  if (
    !SHA256.test(target.target_profile_identity_sha256) || targetIdentityProtocol === null ||
    (targetIdentityProtocol === "LEGACY_GENERATION_V1" &&
      target.managed_generation !== profile.target_profile.generation)
  ) {
    throw new ManagedTargetManifestError(
      "MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH",
      "Core target identity is neither the exact physical profile digest nor a compatible exact legacy identity",
    );
  }
  return Object.freeze({
    target_profile_sha256: targetProfileDigest,
    projection_profile_sha256: await projectionDigest({
      projector_profile: profile.projection_profile.projector_profile,
      target_item_utf8_bytes: profile.projection_profile.target_item_utf8_bytes,
      maximum_item_utf8_bytes: profile.projection_profile.maximum_item_utf8_bytes,
    }),
  });
}

export async function validateManifestTarget(target: ManagedTargetIdentity): Promise<void> {
  if (
    !IDENTIFIER.test(target.namespace) || !IDENTIFIER.test(target.managed_instance_id) ||
    !IDENTIFIER.test(target.managed_generation) || !SHA256.test(target.target_profile_identity_sha256)
  ) throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_INPUT_INVALID", "managed target identity is malformed");
}

export async function shadowFenceDigest(fence: ManagedTargetManifestShadowFence): Promise<string> {
  return projectionDigest({
    protocol: "eliotr.managed-target-shadow-fence.v1",
    registry_revision: fence.registry_revision,
    registry_sha256: fence.registry_sha256,
    active_head_generation: fence.active_head_generation,
    generation_state: fence.generation_state,
    generation_profile_identity_sha256: fence.generation_profile_identity_sha256,
    expected_item_count: fence.expected_item_count,
  });
}

export function validateShadowFence(
  fence: ManagedTargetManifestShadowFence,
  target: ManagedTargetIdentity,
  targetPhysicalProfileSha256: string,
): void {
  if (
    (fence.registry_revision !== null && (!Number.isSafeInteger(fence.registry_revision) || fence.registry_revision < 1)) ||
    (fence.registry_sha256 !== null && !SHA256.test(fence.registry_sha256)) ||
    ((fence.registry_revision === null) !== (fence.registry_sha256 === null)) ||
    (fence.active_head_generation !== null && !IDENTIFIER.test(fence.active_head_generation))
  ) throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "SEARCH_DB shadow fence is malformed");
  if (fence.active_head_generation === target.managed_generation || fence.generation_state === "ACTIVE" ||
      fence.generation_state === "INACTIVE_QUALIFIED" || fence.generation_state === "INACTIVE_UNQUALIFIED" ||
      fence.generation_state === "RETIRED" || fence.generation_state === "BLOCKED") {
    throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_SHADOW_REQUIRED", "only a fresh declared/shadow registry generation may be built");
  }
  if (fence.generation_state === "UNDECLARED") {
    if (fence.generation_profile_identity_sha256 !== null || fence.expected_item_count !== null) {
      throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "undeclared registry generation carries record fields");
    }
    return;
  }
  if (!(["DECLARED", "SHADOW_BUILDING", "SHADOW_COMPLETE"] as readonly ManagedTargetManifestShadowState[]).includes(fence.generation_state)) {
    throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_SHADOW_REQUIRED", "registry state is not eligible for a fresh shadow build");
  }
  if (fence.generation_profile_identity_sha256 !== targetPhysicalProfileSha256 ||
      !Number.isSafeInteger(fence.expected_item_count) || (fence.expected_item_count ?? -1) < 0) {
    throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "shadow registry profile/count fence is invalid");
  }
}

export function validateManagedRequiredSetFence(fence: ManagedRequiredSetFence): ManagedRequiredSetFence {
  if (
    !SHA256.test(fence.assignment_heads_sha256) ||
    !Number.isSafeInteger(fence.assigned_project_count) || fence.assigned_project_count < 0 ||
    !Number.isSafeInteger(fence.stale_assignment_count) || fence.stale_assignment_count < 0 ||
    !Number.isSafeInteger(fence.profile_mismatch_count) || fence.profile_mismatch_count < 0
  ) throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "Core assignment-head fence is malformed");
  if (fence.stale_assignment_count !== 0 || fence.profile_mismatch_count !== 0) {
    throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "Core assignment-head fence has stale or incompatible assignments");
  }
  return fence;
}

export async function sourceAuthorityDigest(input: {
  readonly target: ManagedTargetIdentity;
  readonly profile: ManagedTargetManifestProfile;
  readonly copy: ManagedRequiredProjectRevisionCopy;
  readonly authority: ManagedTargetManifestSourceAuthority;
}): Promise<string> {
  const { target, profile, copy, authority } = input;
  const revision = authority.source_revision;
  if (
    revision.source_revision_ref !== copy.source_revision_ref || revision.source_id !== copy.source_id ||
    revision.source_namespace_id !== copy.source_namespace_id || revision.source_owner_system_id !== copy.source_owner_system_id ||
    revision.source_owner_generation !== copy.source_owner_generation || revision.ownership_mode !== copy.source_ownership_mode ||
    revision.content_sha256 !== copy.source_revision_content_sha256 || revision.object_residency_key_digest.length !== 64 ||
    revision.normalized_artifact_ref !== copy.normalized_artifact_ref || revision.purge_state !== "LIVE" ||
    !SHA256.test(revision.content_sha256) || !SHA256.test(revision.object_residency_key_digest) ||
    authority.source_class !== copy.source_class || !IDENTIFIER.test(authority.source_class) ||
    typeof authority.source_title !== "string" || authority.source_title.length === 0 ||
    !["CLEARED", "DATA_ONLY", "UNTRUSTED", "COMMAND_LIKE"].includes(authority.instruction_taint)
  ) throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "Core source authority differs from its exact required-set row");
  return projectionDigest({
    protocol: "eliotr.managed-target-source-projection-authority.v1",
    target,
    copy_layout: profile.copy_layout,
    projection_profile_sha256: await projectionDigest(profile.projection_profile),
    copy_identity: {
      project_id: copy.project_id,
      project_membership_id: copy.project_membership_id,
      membership_generation: copy.membership_generation,
      source_id: copy.source_id,
      source_revision_ref: copy.source_revision_ref,
    },
    authority: {
      source_revision: revision,
      source_title: authority.source_title,
      source_class: authority.source_class,
      instruction_taint: authority.instruction_taint,
    },
  });
}

export function validateCanonicalTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_INPUT_INVALID", "timestamp must be canonical UTC");
  }
}

export async function capacityIdentityDigest(receipt: {
  readonly protocol: string;
  readonly account_tier: string;
  readonly account_authority_ref: string;
  readonly account_authority_sha256: string;
  readonly max_files_per_instance: number;
  readonly documentation_modified_on: string;
}): Promise<string> {
  return projectionDigest(receipt);
}

export async function requireOperationBudget(
  budget: ManagedTargetManifestOperationBudgetReceipt,
  fail: (code: ManagedTargetManifestErrorCode, message: string) => never,
): Promise<ManagedTargetManifestOperationBudgetReceipt> {
  try { return validateOperationBudgetReceipt(budget); }
  catch { return fail("MANAGED_TARGET_MANIFEST_BUDGET_UNAVAILABLE", "operation did not report a bounded subrequest/CPU/input receipt"); }
}

export function canonicalObjectBytes(value: unknown): Uint8Array {
  return utf8ProjectionBytes(canonicalProjectionJson(value));
}
