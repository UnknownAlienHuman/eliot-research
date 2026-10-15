import type { ProjectionItem } from "@eliotr/contracts";
import {
  DeliveryRuntimeError,
  type ExecutionFence,
} from "@eliotr/platform-cloudflare";
import { StructuralProjectionError } from "@eliotr/retrieval";
import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  assertProjectionSha256,
  canonicalProjectionJson,
  profileIsValid,
  projectionFail,
  projectionGeneration,
  utf8ProjectionLength,
} from "./canonical.js";
import { preflightManagedProjectCopies } from "./core-managed-item-intent.js";
import type {
  CanonicalProjectionResourceBounds,
  CanonicalSourceProjectionReceipt,
  ManagedProjectCopyMapSetReceipt,
  ManagedProjectCopyPlan,
  ManagedProjectionReceipt,
  ManagedTargetSelectionV2,
  ProjectionAuthorityPort,
  ProjectionExecutionProfile,
  ProjectionExecutorDependencies,
  ProjectionSearchReceipt,
  ProjectionSettlement,
  ProjectionSourceContext,
  ProjectionTerminalReceipt,
  ProjectionWorkReceipt,
} from "./types.js";

export interface PreparedProjectionDeltaTarget {
  readonly selection: ManagedTargetSelectionV2;
  readonly profile: ProjectionExecutionProfile;
  readonly role: "ACTIVE" | "SHADOW";
  readonly execution_generation: string;
  readonly prior_terminal: ProjectionTerminalReceipt | null;
  readonly preflight: Awaited<ReturnType<typeof preflightManagedProjectCopies>> | null;
  readonly requires_sharding: boolean;
}

export interface PreparedProjectionDeltaTargets {
  readonly targets: readonly PreparedProjectionDeltaTarget[];
}

const SELECTION_KEYS = [
  "decision_version",
  "domain",
  "product_alias",
  "protocol",
  "purpose",
  "registry_artifact_sha256",
  "registry_revision",
  "selection_mode",
  "target",
  "v1_exact_profile_identity_sha256",
] as const;
const TARGET_IDENTITY_KEYS = [
  "managed_generation",
  "managed_instance_id",
  "namespace",
  "target_profile_identity_sha256",
] as const;

function exactObjectKeys(value: unknown, keys: readonly string[], label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", `${label} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", `${label} has unknown or missing fields`);
  }
}

function sameProjectorBounds(
  left: ProjectionExecutionProfile,
  right: ProjectionExecutionProfile,
): boolean {
  return canonicalProjectionJson({
    projector_profile: left.projector_profile,
    maximum_markdown_bytes: left.maximum_markdown_bytes,
    maximum_synchronous_items: left.maximum_synchronous_items,
    target_item_utf8_bytes: left.target_item_utf8_bytes,
    maximum_item_utf8_bytes: left.maximum_item_utf8_bytes,
    managed_poll_interval_ms: left.managed_poll_interval_ms,
    managed_timeout_ms: left.managed_timeout_ms,
  }) === canonicalProjectionJson({
    projector_profile: right.projector_profile,
    maximum_markdown_bytes: right.maximum_markdown_bytes,
    maximum_synchronous_items: right.maximum_synchronous_items,
    target_item_utf8_bytes: right.target_item_utf8_bytes,
    maximum_item_utf8_bytes: right.maximum_item_utf8_bytes,
    managed_poll_interval_ms: right.managed_poll_interval_ms,
    managed_timeout_ms: right.managed_timeout_ms,
  });
}

/**
 * Validate Root's existing internal V2 target receipts. This module does not
 * read SEARCH_DB or define a second selection protocol.
 */
export function validateRootSelectedProjectionTargets(
  selections: readonly ManagedTargetSelectionV2[],
  baseProfile: ProjectionExecutionProfile,
): readonly {
  readonly selection: ManagedTargetSelectionV2;
  readonly profile: ProjectionExecutionProfile;
  readonly role: "ACTIVE" | "SHADOW";
}[] {
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > 2) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root must supply one ACTIVE and at most one SHADOW selection");
  }
  profileIsValid(baseProfile);
  const active = selections[0];
  if (active === undefined || active.purpose !== "ACTIVE") {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root-selected target list must begin with its current ACTIVE selection");
  }
  const targets: {
    readonly selection: ManagedTargetSelectionV2;
    readonly profile: ProjectionExecutionProfile;
    readonly role: "ACTIVE" | "SHADOW";
  }[] = [];
  const generations = new Set<string>();
  let previous: ManagedTargetSelectionV2 | undefined;
  let previousProfile: ProjectionExecutionProfile | undefined;
  for (const [index, selection] of selections.entries()) {
    exactObjectKeys(selection, SELECTION_KEYS, `Root target selection ${index}`);
    exactObjectKeys(selection.target, TARGET_IDENTITY_KEYS, `Root target identity ${index}`);
    const role = index === 0 ? "ACTIVE" : "SHADOW";
    if (
      selection.protocol !== "eliotr.managed-target-selection.v2" ||
      selection.domain !== "MANAGED_SEARCH_PRODUCT" ||
      selection.decision_version !== 2 ||
      selection.selection_mode !== "STABLE_PHYSICAL_PROFILE_V2" ||
      selection.product_alias !== "primary" ||
      selection.purpose !== role
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root target selection is not the exact V2 ACTIVE/SHADOW receipt");
    }
    assertProjectionInteger(selection.registry_revision, "Root selection registry revision", 1, Number.MAX_SAFE_INTEGER);
    assertProjectionSha256(selection.registry_artifact_sha256, "Root selection registry artifact digest");
    assertProjectionSha256(
      selection.v1_exact_profile_identity_sha256,
      "Root selection V1 exact registry profile digest",
    );
    assertProjectionIdentifier(selection.target.namespace, "Root-selected registry namespace");
    assertProjectionIdentifier(selection.target.managed_instance_id, "Root-selected managed instance");
    assertProjectionIdentifier(selection.target.managed_generation, "Root-selected managed generation");
    assertProjectionSha256(selection.target.target_profile_identity_sha256, "Root-selected physical profile digest");
    const generation = selection.target.managed_generation;
    if (generations.has(generation)) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root selected the same logical generation more than once");
    }
    if (previous !== undefined && (
      previous.registry_revision !== selection.registry_revision ||
      previous.registry_artifact_sha256 !== selection.registry_artifact_sha256 ||
      previous.target.namespace !== selection.target.namespace ||
      previous.target.managed_instance_id !== selection.target.managed_instance_id ||
      previous.target.target_profile_identity_sha256 !== selection.target.target_profile_identity_sha256
    )) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root ACTIVE/SHADOW selections do not share one registry snapshot and physical profile");
    }
    const profile: ProjectionExecutionProfile = Object.freeze({
      ...baseProfile,
      managed_instance_id: selection.target.managed_instance_id,
      managed_generation: selection.target.managed_generation,
      managed_generation_active: role === "ACTIVE",
    });
    profileIsValid(profile);
    if (previousProfile !== undefined && !sameProjectorBounds(previousProfile, profile)) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root-selected target profiles do not share one projector resource envelope");
    }
    generations.add(generation);
    targets.push(Object.freeze({ selection, profile, role }));
    previous = selection;
    previousProfile = profile;
  }
  return Object.freeze(targets);
}

export async function prepareRootSelectedProjectionTargets(input: {
  readonly context: ProjectionSourceContext;
  readonly selections: readonly ManagedTargetSelectionV2[];
  readonly base_profile: ProjectionExecutionProfile;
  readonly authority: ProjectionAuthorityPort;
}): Promise<PreparedProjectionDeltaTargets> {
  const selected = validateRootSelectedProjectionTargets(input.selections, input.base_profile);
  const targets: PreparedProjectionDeltaTarget[] = [];
  for (const target of selected) {
    const executionGeneration = await projectionGeneration(input.context, target.profile);
    const priorTerminal = await input.authority.readTerminal(
      input.context,
      executionGeneration,
      target.profile,
    );
    if (priorTerminal !== null) {
      assertProjectionIdentifier(priorTerminal.receipt_ref, "Root-selected target terminal receipt reference");
      if (
        priorTerminal.projection_generation !== executionGeneration ||
        priorTerminal.receipt.outcome !== priorTerminal.outcome
      ) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root-selected target terminal readback differs from its exact generation");
      }
    }
    targets.push(Object.freeze({
      selection: target.selection,
      profile: target.profile,
      role: target.role,
      execution_generation: executionGeneration,
      prior_terminal: priorTerminal,
      preflight: null,
      requires_sharding: false,
    }));
  }
  return Object.freeze({ targets: Object.freeze(targets) });
}

export async function preflightRootSelectedProjectionTargets(input: {
  readonly context: ProjectionSourceContext;
  readonly projection_items: readonly ProjectionItem[];
  readonly prepared: PreparedProjectionDeltaTargets;
}): Promise<PreparedProjectionDeltaTargets> {
  const targets: PreparedProjectionDeltaTarget[] = [];
  for (const prepared of input.prepared.targets) {
    if (prepared.prior_terminal !== null) {
      targets.push(prepared);
      continue;
    }
    const canonicalTooLarge = input.projection_items.length > prepared.profile.maximum_synchronous_items;
    const preflight = canonicalTooLarge
      ? null
      : await preflightManagedProjectCopies(input.context, prepared.profile, input.projection_items);
    targets.push(Object.freeze({
      ...prepared,
      preflight,
      requires_sharding: canonicalTooLarge ||
        (preflight !== null && preflight.physical_item_count > prepared.profile.maximum_synchronous_items),
    }));
  }
  return Object.freeze({ targets: Object.freeze(targets) });
}

export function verifyCanonicalSourceReceipt(
  canonical: CanonicalSourceProjectionReceipt,
  context: ProjectionSourceContext,
  generation: string,
  projectorProfileSha256: string,
  resourceBounds: CanonicalProjectionResourceBounds,
  projection: { readonly items: readonly ProjectionItem[]; readonly item_set_digest: string },
): void {
  if (
    canonical.protocol !== "eliotr.canonical-source-projection.v1" ||
    canonical.source_revision_ref !== context.source_revision.source_revision_ref ||
    canonical.complete_residency_key_sha256 !== context.source_revision.object_residency_key_digest ||
    canonical.projector_profile_sha256 !== projectorProfileSha256 ||
    canonical.canonical_projection_generation !== generation ||
    canonical.canonical_section_count !== projection.items.length ||
    canonical.canonical_section_set_sha256 !== projection.item_set_digest ||
    canonical.sections.length !== projection.items.length ||
    canonicalProjectionJson(canonical.resource_bounds) !== canonicalProjectionJson(resourceBounds)
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "canonical Work receipt differs from the exact source projection");
  }
  for (const [index, item] of projection.items.entries()) {
    const section = canonical.sections[index];
    if (
      section === undefined ||
      section.canonical_item_key !== item.item_key ||
      section.canonical_section_id !== item.canonical_section_id ||
      section.content_sha256 !== item.content_sha256
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "canonical Work sections differ from projector output");
    }
  }
  assertProjectionIdentifier(canonical.canonical_source_ref, "canonical source Work ref");
  assertProjectionSha256(canonical.canonical_source_sha256, "canonical source Work digest");
}

export function verifyProjectCopyMapSet(
  mapSet: ManagedProjectCopyMapSetReceipt,
  canonical: CanonicalSourceProjectionReceipt,
  plan: ManagedProjectCopyPlan,
): void {
  if (
    mapSet.source_revision_ref !== canonical.source_revision_ref ||
    mapSet.complete_residency_key_sha256 !== canonical.complete_residency_key_sha256 ||
    mapSet.canonical_projection_generation !== canonical.canonical_projection_generation ||
    mapSet.canonical_source_ref !== canonical.canonical_source_ref ||
    mapSet.canonical_source_sha256 !== canonical.canonical_source_sha256 ||
    mapSet.target.managed_instance_id !== plan.target.managed_instance_id ||
    mapSet.target.managed_generation !== plan.target.managed_generation ||
    mapSet.target.metadata_generation_digest !== plan.target.metadata_generation_digest ||
    mapSet.provider_copy_count !== plan.provider_copy_count ||
    mapSet.provider_copy_set_sha256 !== plan.provider_copy_set_sha256 ||
    mapSet.provider_item_count !== plan.provider_item_count ||
    mapSet.provider_item_set_sha256 !== plan.provider_item_set_sha256
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "project-copy Work receipt differs from the complete provider plan");
  }
  if (mapSet.protocol === "eliotr.managed-project-copy-map-set.v1") {
    if (
      plan.layout !== undefined ||
      plan.target_selection !== undefined ||
      plan.scope_snapshot_id !== undefined ||
      plan.scope_snapshot_revision !== undefined ||
      plan.scope_snapshot_digest !== undefined ||
      plan.project_copy_map_index_protocol !== undefined ||
      plan.project_copy_map_index_ref !== undefined ||
      plan.project_copy_map_index_sha256 !== undefined
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V1 map-set receipt cannot satisfy a V2 copy plan");
    }
    return;
  }
  const selection = plan.target_selection;
  if (
    mapSet.protocol !== "eliotr.managed-project-copy-map-set.v2" ||
    plan.layout !== "PROJECT_COPY_V2" ||
    mapSet.layout !== "PROJECT_COPY_V2" ||
    selection === undefined ||
    mapSet.scope_snapshot_id !== plan.scope_snapshot_id ||
    mapSet.scope_snapshot_revision !== plan.scope_snapshot_revision ||
    mapSet.scope_snapshot_digest !== plan.scope_snapshot_digest ||
    canonicalProjectionJson(mapSet.target_selection) !== canonicalProjectionJson(selection) ||
    mapSet.copy_map_index_ref.length === 0 ||
    mapSet.provider_copy_count !== plan.provider_copy_count ||
    mapSet.provider_item_count !== plan.provider_item_count ||
    mapSet.pages.length !== mapSet.page_count ||
    mapSet.resource_bounds.protocol !== "eliotr.project-copy-resource-bounds.v2" ||
    mapSet.resource_bounds.provider_copy_count !== mapSet.provider_copy_count ||
    mapSet.resource_bounds.provider_item_count !== mapSet.provider_item_count ||
    mapSet.resource_bounds.copy_map_page_count !== mapSet.page_count ||
    mapSet.resource_bounds.copy_map_index_put_count !== 1 ||
    mapSet.resource_bounds.copy_map_r2_put_count !== mapSet.page_count + 1 ||
    mapSet.resource_bounds.copy_map_r2_subrequest_bound !== 2 * (mapSet.page_count + 1) ||
    mapSet.resource_bounds.copy_map_r2_subrequest_bound > mapSet.resource_bounds.maximum_subrequest_bound ||
    mapSet.resource_bounds.cpu_time_budget_ms !== 30_000 ||
    mapSet.resource_bounds.maximum_subrequest_bound !== 10_000
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 map-set receipt differs from its selected scope or index plan");
  }
  assertProjectionIdentifier(mapSet.scope_snapshot_id, "V2 copy map scope snapshot ID");
  assertProjectionInteger(mapSet.scope_snapshot_revision, "V2 copy map scope revision", 1, Number.MAX_SAFE_INTEGER);
  assertProjectionSha256(mapSet.scope_snapshot_digest, "V2 copy map scope digest");
  assertProjectionIdentifier(mapSet.copy_map_index_ref, "V2 copy map index reference");
  assertProjectionSha256(mapSet.copy_map_index_sha256, "V2 copy map index digest");
  assertProjectionSha256(mapSet.page_set_sha256, "V2 copy map page-set digest");
  assertProjectionSha256(mapSet.provider_copy_set_sha256, "V2 provider-copy set digest");
  assertProjectionSha256(mapSet.provider_item_set_sha256, "V2 provider-item set digest");
}

export function verifyWorkSet(
  receipt: ProjectionWorkReceipt,
  projection: {
    readonly items: readonly ProjectionItem[];
    readonly item_set_digest: string;
  },
): void {
  const expectedKeys = new Map(projection.items.map((item) => [item.item_key, item]));
  if (
    expectedKeys.size !== projection.items.length ||
    receipt.item_count !== projection.items.length ||
    receipt.item_set_digest !== projection.item_set_digest ||
    !Array.isArray(receipt.item_receipts) ||
    receipt.item_receipts.length !== projection.items.length
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "Work receipt count or desired-set digest differs from the projected generation",
    );
  }

  const observedKeys = new Set<string>();
  for (const itemReceipt of receipt.item_receipts) {
    const expected = expectedKeys.get(itemReceipt.item_key);
    if (
      expected === undefined ||
      observedKeys.has(itemReceipt.item_key) ||
      itemReceipt.readback_sha256 !== expected.content_sha256 ||
      itemReceipt.size_bytes !== utf8ProjectionLength(expected.section_text)
    ) {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "Work item readback differs from the projected desired set",
      );
    }
    observedKeys.add(itemReceipt.item_key);
  }
  if (observedKeys.size !== expectedKeys.size) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "Work receipt is missing a projected desired item",
    );
  }
}

export function verifySearchSet(
  receipt: ProjectionSearchReceipt,
  projection: {
    readonly items: readonly ProjectionItem[];
    readonly item_set_digest: string;
  },
  generation: string,
): void {
  if (
    receipt.item_count !== projection.items.length ||
    receipt.item_set_digest !== projection.item_set_digest ||
    receipt.projection_generation !== generation
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "D1 Search receipt differs from the projected desired generation",
    );
  }
  assertProjectionIdentifier(receipt.receipt_ref, "D1 Search receipt_ref");
  assertProjectionSha256(receipt.readback_digest, "D1 Search readback_digest");
}

export class DeliveryReconciliationError extends DeliveryRuntimeError {
  public readonly primary_error: unknown;
  public readonly reconciliation_error: unknown;

  public constructor(
    code: DeliveryRuntimeError["code"],
    message: string,
    retryable: boolean,
    primaryError: unknown,
    reconciliationError: unknown,
  ) {
    super(code, message, retryable, primaryError);
    this.name = "DeliveryRuntimeError";
    this.primary_error = primaryError;
    this.reconciliation_error = reconciliationError;
  }
}

export function mapDeliveryFailure(
  error: unknown,
  reconciliation?: { readonly error: unknown },
): never {
  if (error instanceof DeliveryRuntimeError && reconciliation === undefined) throw error;
  let code: DeliveryRuntimeError["code"] = "DELIVERY_SETTLEMENT_UNCERTAIN";
  let retryable = true;
  let message = error instanceof Error ? error.message : "projection execution failed";
  if (error instanceof DeliveryRuntimeError) {
    code = error.code;
    retryable = error.retryable;
    message = error.message;
  } else if (error instanceof StructuralProjectionError) {
    code = "DELIVERY_INPUT_INVALID";
    retryable = false;
    message = error.message;
  } else {
    let nonRetryable = false;
    try {
      if ((typeof error === "object" && error !== null) || typeof error === "function") {
        nonRetryable = (error as { readonly retryable?: unknown }).retryable === false;
      }
    } catch {
      // A malformed thrown value must not replace the failure being mapped.
    }
    if (nonRetryable) {
      code = "DELIVERY_INPUT_INVALID";
      retryable = false;
      message = error instanceof Error ? error.message : "projection input or authority is invalid";
    }
  }
  if (reconciliation !== undefined) {
    throw new DeliveryReconciliationError(code, message, retryable, error, reconciliation.error);
  }
  throw new DeliveryRuntimeError(code, message, retryable, error);
}

export function deliveryFailureAfterReadbackFailure(error: unknown, readbackError: unknown): never {
  return mapDeliveryFailure(error, { error: readbackError });
}

export async function failLeaseQuietly(
  dependencies: ProjectionExecutorDependencies,
  fence: ExecutionFence,
  now: number,
): Promise<void> {
  try {
    await dependencies.leases.fail(fence, "PROJECTION_EXECUTION_FAILED", now);
  } catch {
    // Preserve the original failure. The generation fence prevents stale settlement.
  }
}

export function managedSettlement(
  managed: ManagedProjectionReceipt,
  reasons: readonly string[],
): ProjectionSettlement {
  if (managed.state === "READY") {
    return {
      outcome: "SUCCEEDED",
      reason_codes: [...new Set(reasons)].sort(),
      managed,
    };
  }
  return {
    outcome: "PARTIAL",
    reason_codes: [...new Set([...reasons, ...managed.reason_codes])].sort(),
    managed,
  };
}
