import {
  DeliveryRuntimeError,
  type ExecutionFence,
} from "@eliotr/platform-cloudflare";
import { projectNormalizedMarkdown } from "@eliotr/retrieval";
import {
  profileIsValid,
  projectionGeneration,
  projectionFail,
  stableProjectionId,
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
  ProjectionExecutionHandler,
  ProjectionExecutorDependencies,
  ProjectionSettlement,
  ProjectionSourceContext,
  ProjectionTerminalReceipt,
  ProjectionWorkReceipt,
} from "./types.js";
import {
  deliveryFailureAfterReadbackFailure,
  failLeaseQuietly,
  managedSettlement,
  mapDeliveryFailure,
  verifyCanonicalSourceReceipt,
  verifyProjectCopyMapSet,
  verifySearchSet,
  verifyWorkSet,
} from "./active-delta.js";
import { executeRootSelectedProjectionDeltas } from "./active-delta-executor.js";

const DEFAULT_WORKER_ID = "eliotr-projection-executor";
const DEFAULT_LEASE_MS = 5 * 60_000;

function deliveryFailure(error: unknown): never {
  return mapDeliveryFailure(error);
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
    async execute(message, rootSelectedSelections) {
      const context = await dependencies.authority.load(message);
      if (rootSelectedSelections !== undefined) {
        if (dependencies.serving_target_delta === undefined) {
          projectionFail("PROJECTION_INPUT_INVALID", "Root-selected target execution requires the ACTIVE-delta port");
        }
        try {
          return await executeRootSelectedProjectionDeltas(
            dependencies,
            context,
            rootSelectedSelections,
            now,
            workerId,
            leaseMs,
          );
        } catch (error) {
          deliveryFailure(error);
        }
      }
      if (dependencies.serving_target_delta !== undefined) {
        projectionFail("PROJECTION_INPUT_INVALID", "ACTIVE-delta execution requires Root-selected profiles from the same Queue delivery");
      }
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
