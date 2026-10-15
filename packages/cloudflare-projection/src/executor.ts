import {
  DeliveryRuntimeError,
  type ExecutionFence,
} from "@eliotr/platform-cloudflare";
import { projectNormalizedMarkdown, StructuralProjectionError } from "@eliotr/retrieval";
import type { ProjectionItem } from "@eliotr/contracts";
import {
  assertProjectionIdentifier,
  assertProjectionSha256,
  canonicalProjectionJson,
  profileIsValid,
  projectionGeneration,
  projectionFail,
  stableProjectionId,
  utf8ProjectionLength,
} from "./canonical.js";
import {
  bindProjectCopyMapIndex,
  buildManagedProjectCopyPlan,
  canonicalSourceProjectionIdentity,
  canonicalSourceResourceBounds,
  managedProjectCopyScopeForProfile,
  preflightManagedProjectCopies,
} from "./core-managed-item-intent.js";
import type {
  CanonicalProjectionResourceBounds,
  CanonicalSourceProjectionReceipt,
  ManagedProjectCopyMapSetReceipt,
  ManagedProjectCopyPlan,
  ManagedProjectionReceipt,
  ProjectionExecutionHandler,
  ProjectionExecutorDependencies,
  ProjectionSearchReceipt,
  ProjectionSettlement,
  ProjectionSourceContext,
  ProjectionTerminalReceipt,
  ProjectionWorkReceipt,
} from "./types.js";

const DEFAULT_WORKER_ID = "eliotr-projection-executor";
const DEFAULT_LEASE_MS = 5 * 60_000;

function verifyCanonicalSourceReceipt(
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

function verifyProjectCopyMapSet(
  mapSet: ManagedProjectCopyMapSetReceipt,
  canonical: CanonicalSourceProjectionReceipt,
  plan: ManagedProjectCopyPlan,
): void {
  if (
    mapSet.protocol !== "eliotr.managed-project-copy-map-set.v1" ||
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
}

function verifyWorkSet(
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

function verifySearchSet(
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

function deliveryFailure(error: unknown): never {
  return mapDeliveryFailure(error);
}

class DeliveryReconciliationError extends DeliveryRuntimeError {
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

function mapDeliveryFailure(
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
      if (
        (typeof error === "object" && error !== null) ||
        typeof error === "function"
      ) {
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
    throw new DeliveryReconciliationError(
      code,
      message,
      retryable,
      error,
      reconciliation.error,
    );
  }
  throw new DeliveryRuntimeError(code, message, retryable, error);
}

function deliveryFailureAfterReadbackFailure(
  error: unknown,
  readbackError: unknown,
): never {
  return mapDeliveryFailure(error, { error: readbackError });
}

async function failLeaseQuietly(
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

function managedSettlement(
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

async function settleSharded(
  dependencies: ProjectionExecutorDependencies,
  context: ProjectionSourceContext,
  generation: string,
  fence: ExecutionFence,
): Promise<{ readonly receipt_ref: string }> {
  const terminal = await dependencies.authority.settle(context, generation, dependencies.profile, {
    outcome: "PARTIAL",
    reason_codes: ["SHARDED_WORKFLOW_REQUIRED"],
  }, fence);
  return { receipt_ref: terminal.receipt_ref };
}

export function createProjectionExecutionHandler(
  dependencies: ProjectionExecutorDependencies,
): ProjectionExecutionHandler {
  profileIsValid(dependencies.profile);
  const now = dependencies.now ?? Date.now;
  const workerId = dependencies.worker_id ?? DEFAULT_WORKER_ID;
  const leaseMs = dependencies.lease_ms ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 24 * 60 * 60 * 1000) {
    projectionFail("PROJECTION_INPUT_INVALID", "projection lease_ms is outside its allowed range");
  }

  return {
    async execute(message) {
      const context = await dependencies.authority.load(message);
      const generation = await projectionGeneration(context, dependencies.profile);
      const prior = await dependencies.authority.readTerminal(context, generation, dependencies.profile);
      if (prior !== null) return { receipt_ref: prior.receipt_ref };

      const operationId = await stableProjectionId(
        "projection-execute",
        context.intent_ref.id,
        String(context.intent_ref.revision),
        generation,
      );
      const acquiredAt = now();
      if (!Number.isSafeInteger(acquiredAt) || acquiredAt < 0) {
        projectionFail("PROJECTION_INPUT_INVALID", "projection clock is invalid");
      }
      const lease = await dependencies.leases.acquire({
        operation_id: operationId,
        operation_kind: "PROJECTION_EXECUTE",
        lease_owner: workerId,
        now_ms: acquiredAt,
        lease_ms: leaseMs,
      });
      if (lease === null) {
        const reconciled = await dependencies.authority.readTerminal(context, generation, dependencies.profile);
        if (reconciled !== null) return { receipt_ref: reconciled.receipt_ref };
        throw new DeliveryRuntimeError(
          "DELIVERY_LEASE_LOST",
          "another worker owns the projection execution generation",
          true,
        );
      }
      const fence: ExecutionFence = {
        operation_id: lease.operation_id,
        lease_owner: lease.lease_owner,
        lease_generation: lease.lease_generation,
      };

      try {
        await dependencies.authority.begin(context, generation, dependencies.profile, fence);
        const content = await dependencies.content.read(
          context,
          dependencies.profile.maximum_markdown_bytes,
        );
        if (content.disposition === "SHARDED_WORKFLOW_REQUIRED") {
          const result = await settleSharded(dependencies, context, generation, fence);
          try { await dependencies.leases.complete(fence, result.receipt_ref, now()); }
          catch { /* the durable terminal receipt is authority */ }
          return result;
        }

        const canonicalIdentity = await canonicalSourceProjectionIdentity(context, dependencies.profile);
        const canonicalSourceContext = {
          source_revision: context.source_revision,
          source_title: context.source_title,
          source_class: context.source_class,
          instruction_taint: context.instruction_taint,
        } as const;
        const projection = await projectNormalizedMarkdown({
          source_revision: context.source_revision,
          title: context.source_title,
          source_class: context.source_class,
          markdown: content.markdown,
          instruction_taint: context.instruction_taint,
          project_membership_ids: [],
          projection_generation: canonicalIdentity.generation,
          target_item_utf8_bytes: dependencies.profile.target_item_utf8_bytes,
          max_item_utf8_bytes: dependencies.profile.maximum_item_utf8_bytes,
        });
        if (projection.markdown_sha256 !== context.source_revision.content_sha256) {
          projectionFail(
            "PROJECTION_AUTHORITY_CONFLICT",
            "projector readback digest differs from the admitted SourceRevision",
          );
        }
        if (projection.items.length > dependencies.profile.maximum_synchronous_items) {
          const result = await settleSharded(dependencies, context, generation, fence);
          try { await dependencies.leases.complete(fence, result.receipt_ref, now()); }
          catch { /* the durable terminal receipt is authority */ }
          return result;
        }

        const copyPreflight = await preflightManagedProjectCopies(
          context,
          dependencies.profile,
          projection.items,
        );
        if (copyPreflight.physical_item_count > dependencies.profile.maximum_synchronous_items) {
          const result = await settleSharded(dependencies, context, generation, fence);
          try { await dependencies.leases.complete(fence, result.receipt_ref, now()); }
          catch { /* the durable terminal receipt is authority */ }
          return result;
        }

        const resourceBounds = canonicalSourceResourceBounds(
          dependencies.profile,
          content.size_bytes,
          projection.items,
        );
        const canonicalWork = await dependencies.work.materialize(
          canonicalSourceContext,
          canonicalIdentity.generation,
          projection,
          canonicalIdentity.profile_sha256,
          resourceBounds,
        );
        const canonicalSource = canonicalWork.canonical_source;
        if (canonicalSource === undefined) {
          projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Work did not return its canonical source receipt");
        }
        verifyCanonicalSourceReceipt(
          canonicalSource,
          context,
          canonicalIdentity.generation,
          canonicalIdentity.profile_sha256,
          resourceBounds,
          projection,
        );
        const copyPlan = await buildManagedProjectCopyPlan(
          context,
          dependencies.profile,
          canonicalSource,
          projection.items,
          copyPreflight,
        );
        if (
          copyPlan.provider_copy_count !== copyPreflight.provider_copy_count ||
          copyPlan.items.length !== copyPreflight.physical_item_count ||
          copyPlan.target.metadata_generation_digest !== copyPreflight.metadata_generation_digest ||
          copyPlan.items.some((item, index) => {
            const expected = copyPreflight.items[index];
            return expected === undefined ||
              item.item_key !== expected.item_key ||
              item.canonical_item_key !== expected.canonical_item_key ||
              item.canonical_section_id !== expected.canonical_section_id ||
              item.content_sha256 !== expected.content_sha256 ||
              item.normalized_start_byte !== expected.normalized_start_byte ||
              item.normalized_end_byte !== expected.normalized_end_byte ||
              item.provider_key !== expected.provider_key ||
              item.project_id !== expected.project_id ||
              item.project_membership_id !== expected.project_membership_id ||
              item.membership_generation !== expected.membership_generation ||
              item.membership_identity_version !== expected.membership_identity_version ||
              item.legacy_project_membership_id !== expected.legacy_project_membership_id ||
              item.stable_project_membership_id !== expected.stable_project_membership_id ||
              item.membership_revision !== expected.membership_revision ||
              item.project_membership_generation !== expected.project_membership_generation;
          })
        ) {
          projectionFail("PROJECTION_AUTHORITY_CONFLICT", "complete provider plan changed after preflight");
        }
        const copyScope = managedProjectCopyScopeForProfile(context, dependencies.profile);
        const projectCopyMapSet = await dependencies.work.materializeProjectCopyMapPages(
          canonicalSource,
          copyPlan.target,
          copyPlan.copies,
          copyScope,
        );
        verifyProjectCopyMapSet(projectCopyMapSet, canonicalSource, copyPlan);
        const providerCopyPlan = bindProjectCopyMapIndex(copyPlan, projectCopyMapSet);
        const work: ProjectionWorkReceipt = {
          ...canonicalWork,
          canonical_projection_generation: canonicalIdentity.generation,
          metadata_generation_digest: copyPlan.target.metadata_generation_digest,
          project_copy_map_set: projectCopyMapSet,
        };
        verifyWorkSet(work, projection);
        await dependencies.authority.recordMaterialized(context, generation, work, fence);
        const d1Search = await dependencies.search.activate(
          context,
          canonicalIdentity.generation,
          projection,
        );
        verifySearchSet(d1Search, projection, canonicalIdentity.generation);
        const managed = await dependencies.managed.index(
          context,
          generation,
          canonicalIdentity.generation,
          providerCopyPlan,
          fence,
        );
        const baseSettlement = managedSettlement(managed, []);
        const settlement: ProjectionSettlement = {
          ...baseSettlement,
          work,
          d1_search: d1Search,
        };
        const terminal = await dependencies.authority.settle(context, generation, dependencies.profile, settlement, fence);
        try { await dependencies.leases.complete(fence, terminal.receipt_ref, now()); }
        catch { /* exact terminal readback outranks coordination state */ }
        return { receipt_ref: terminal.receipt_ref };
      } catch (error) {
        let reconciled: ProjectionTerminalReceipt | null;
        try {
          reconciled = await dependencies.authority.readTerminal(
            context,
            generation,
            dependencies.profile,
          );
        } catch (readbackError) {
          deliveryFailureAfterReadbackFailure(error, readbackError);
        }
        if (reconciled !== null) {
          try { await dependencies.leases.complete(fence, reconciled.receipt_ref, now()); }
          catch { /* exact terminal readback is sufficient */ }
          return { receipt_ref: reconciled.receipt_ref };
        }
        await failLeaseQuietly(dependencies, fence, now());
        deliveryFailure(error);
      }
    },
  };
}
