import {
  DeliveryRuntimeError,
  type ExecutionFence,
} from "@eliotr/platform-cloudflare";
import { projectNormalizedMarkdown, StructuralProjectionError } from "@eliotr/retrieval";
import {
  profileIsValid,
  projectionGeneration,
  projectionFail,
  stableProjectionId,
  type ProjectionRuntimeError,
} from "./canonical.js";
import type {
  ManagedProjectionReceipt,
  ProjectionExecutionHandler,
  ProjectionExecutorDependencies,
  ProjectionSettlement,
  ProjectionSourceContext,
} from "./types.js";

const DEFAULT_WORKER_ID = "eliotr-projection-executor";
const DEFAULT_LEASE_MS = 5 * 60_000;

function deliveryFailure(error: unknown): never {
  if (error instanceof DeliveryRuntimeError) throw error;
  if (error instanceof StructuralProjectionError) {
    throw new DeliveryRuntimeError(
      "DELIVERY_INPUT_INVALID",
      error.message,
      false,
      error,
    );
  }
  const candidate = error as Partial<ProjectionRuntimeError>;
  if (candidate.retryable === false) {
    throw new DeliveryRuntimeError(
      "DELIVERY_INPUT_INVALID",
      error instanceof Error ? error.message : "projection input or authority is invalid",
      false,
      error,
    );
  }
  throw new DeliveryRuntimeError(
    "DELIVERY_SETTLEMENT_UNCERTAIN",
    error instanceof Error ? error.message : "projection execution failed",
    true,
    error,
  );
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
): Promise<{ readonly receipt_ref: string }> {
  const terminal = await dependencies.authority.settle(context, generation, dependencies.profile, {
    outcome: "PARTIAL",
    reason_codes: ["SHARDED_WORKFLOW_REQUIRED"],
  });
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
        await dependencies.authority.begin(context, generation, dependencies.profile);
        const content = await dependencies.content.read(
          context,
          dependencies.profile.maximum_markdown_bytes,
        );
        if (content.disposition === "SHARDED_WORKFLOW_REQUIRED") {
          const result = await settleSharded(dependencies, context, generation);
          try { await dependencies.leases.complete(fence, result.receipt_ref, now()); }
          catch { /* the durable terminal receipt is authority */ }
          return result;
        }

        const projection = await projectNormalizedMarkdown({
          source_revision: context.source_revision,
          title: context.source_title,
          source_class: context.source_class,
          markdown: content.markdown,
          instruction_taint: context.instruction_taint,
          project_membership_ids: context.project_membership_ids,
          projection_generation: generation,
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
          const result = await settleSharded(dependencies, context, generation);
          try { await dependencies.leases.complete(fence, result.receipt_ref, now()); }
          catch { /* the durable terminal receipt is authority */ }
          return result;
        }

        const work = await dependencies.work.materialize(context, generation, projection);
        await dependencies.authority.recordMaterialized(context, generation, work);
        const d1Search = await dependencies.search.activate(context, generation, projection);
        const managed = await dependencies.managed.index(
          context,
          generation,
          projection.items,
        );
        const baseSettlement = managedSettlement(managed, []);
        const settlement: ProjectionSettlement = {
          ...baseSettlement,
          work,
          d1_search: d1Search,
        };
        const terminal = await dependencies.authority.settle(context, generation, dependencies.profile, settlement);
        try { await dependencies.leases.complete(fence, terminal.receipt_ref, now()); }
        catch { /* exact terminal readback outranks coordination state */ }
        return { receipt_ref: terminal.receipt_ref };
      } catch (error) {
        const reconciled = await dependencies.authority.readTerminal(context, generation, dependencies.profile);
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
