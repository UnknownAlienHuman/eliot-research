import { DeliveryRuntimeError, type ExecutionFence } from "@eliotr/platform-cloudflare";
import { projectNormalizedMarkdown } from "@eliotr/retrieval";
import {
  canonicalProjectionJson,
  assertProjectionIdentifier,
  assertProjectionSha256,
  projectionFail,
  stableProjectionId,
} from "./canonical.js";
import {
  buildManagedProjectCopyPlan,
  canonicalSourceProjectionIdentity,
  canonicalSourceResourceBounds,
} from "./core-managed-item-intent.js";
import {
  DeliveryReconciliationError,
  failLeaseQuietly,
  mapDeliveryFailure as deliveryFailure,
  managedSettlement,
  preflightRootSelectedProjectionTargets,
  prepareRootSelectedProjectionTargets,
  verifyCanonicalSourceReceipt,
  verifyProjectCopyMapSet,
  verifySearchSet,
  verifyWorkSet,
  type PreparedProjectionDeltaTarget,
} from "./active-delta.js";
import type {
  CanonicalSourceProjectionReceipt,
  ManagedProjectCopyPlan,
  ManagedProjectionReceipt,
  ManagedTargetSelectionV2,
  ProjectionExecutorDependencies,
  ProjectionSearchReceipt,
  ProjectionSettlement,
  ProjectionSourceContext,
  ProjectionTerminalReceipt,
  ProjectionWorkReceipt,
} from "./types.js";
interface ServingTargetExecutionState {
  readonly prepared: PreparedProjectionDeltaTarget;
  fence: ExecutionFence | null;
  terminal: ProjectionTerminalReceipt | null;
  failure: unknown | null;
}

function copyPlanMatchesPreflight(
  copyPlan: ManagedProjectCopyPlan,
  preflight: NonNullable<PreparedProjectionDeltaTarget["preflight"]>,
): boolean {
  if (
    copyPlan.provider_copy_count !== preflight.provider_copy_count ||
    copyPlan.items.length !== preflight.physical_item_count ||
    copyPlan.target.metadata_generation_digest !== preflight.metadata_generation_digest
  ) {
    return false;
  }
  const expectedItems = preflight.items;
  const actualItems = copyPlan.items.map((item, index) => {
    const expected = expectedItems[index];
    if (expected === undefined) return null;
    const actual = item as unknown as Readonly<Record<string, unknown>>;
    return Object.fromEntries(
      Object.keys(expected).sort().map((key) => [key, actual[key]]),
    );
  });
  return canonicalProjectionJson(actualItems) === canonicalProjectionJson(expectedItems);
}

function verifyServingTargetManagedReceipt(
  receipt: ManagedProjectionReceipt,
  state: ServingTargetExecutionState,
  copyPlan: ManagedProjectCopyPlan,
): void {
  const target = state.prepared.profile;
  if (
    receipt.instance_id !== target.managed_instance_id ||
    receipt.managed_generation !== target.managed_generation ||
    !Array.isArray(receipt.reason_codes)
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "target delta readback differs from its selected target");
  }
  if (receipt.state === "READY") {
    assertProjectionIdentifier(receipt.receipt_ref, "selected target managed receipt reference");
    assertProjectionSha256(receipt.readback_digest, "selected target managed readback digest");
    if (receipt.item_count !== copyPlan.items.length || receipt.reason_codes.length !== 0) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "selected target readback count or disposition differs from its plan");
    }
    return;
  }
  if (
    !Number.isSafeInteger(receipt.item_count) ||
    receipt.item_count < 0 ||
    receipt.item_count > copyPlan.items.length ||
    receipt.reason_codes.length === 0
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "degraded target readback is malformed");
  }
  if (receipt.shadow_receipt_ref !== undefined) {
    assertProjectionIdentifier(receipt.shadow_receipt_ref, "selected target shadow receipt reference");
  }
  if (receipt.shadow_readback_digest !== undefined) {
    assertProjectionSha256(receipt.shadow_readback_digest, "selected target shadow readback digest");
  }
}

function verifyServingTargetTerminalReceipt(
  receipt: ProjectionTerminalReceipt,
  state: ServingTargetExecutionState,
): void {
  assertProjectionIdentifier(receipt.receipt_ref, "selected target terminal receipt reference");
  if (
    receipt.projection_generation !== state.prepared.execution_generation ||
    receipt.receipt.outcome !== receipt.outcome
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "selected target terminal readback differs from its execution generation");
  }
}

async function completeServingTargetLeaseQuietly(
  dependencies: ProjectionExecutorDependencies,
  state: ServingTargetExecutionState,
  now: () => number,
): Promise<void> {
  if (state.fence === null || state.terminal === null) return;
  try {
    await dependencies.leases.complete(state.fence, state.terminal.receipt_ref, now());
  } catch {
    // Exact terminal readback is authority when the lease acknowledgement is lost.
  }
}

async function reconcileServingTargetFailure(
  dependencies: ProjectionExecutorDependencies,
  context: ProjectionSourceContext,
  state: ServingTargetExecutionState,
  error: unknown,
  now: () => number,
): Promise<void> {
  if (state.terminal !== null) return;
  if (state.fence === null) {
    state.failure = error;
    return;
  }
  try {
    const terminal = await dependencies.authority.readTerminal(
      context,
      state.prepared.execution_generation,
      state.prepared.profile,
    );
    if (terminal !== null) {
      verifyServingTargetTerminalReceipt(terminal, state);
      state.terminal = terminal;
      await completeServingTargetLeaseQuietly(dependencies, state, now);
      return;
    }
    state.failure = error;
  } catch (readbackError) {
    state.failure = new DeliveryReconciliationError(
      "DELIVERY_SETTLEMENT_UNCERTAIN",
      error instanceof Error ? error.message : "selected target delta failed",
      true,
      error,
      readbackError,
    );
  }
  await failLeaseQuietly(dependencies, state.fence, now());
}

async function settleServingTargetPartial(
  dependencies: ProjectionExecutorDependencies,
  context: ProjectionSourceContext,
  state: ServingTargetExecutionState,
  reason: string,
  now: () => number,
): Promise<void> {
  if (state.fence === null || state.terminal !== null) return;
  const terminal = await dependencies.authority.settle(
    context,
    state.prepared.execution_generation,
    state.prepared.profile,
    { outcome: "PARTIAL", reason_codes: [reason] },
    state.fence,
  );
  verifyServingTargetTerminalReceipt(terminal, state);
  state.terminal = terminal;
  await completeServingTargetLeaseQuietly(dependencies, state, now);
}

function servingTargetDeliveryFailure(states: readonly ServingTargetExecutionState[]): never {
  const failures = states.flatMap((state) => state.failure === null ? [] : [state.failure]);
  if (failures.length === 1) return deliveryFailure(failures[0]);
  return deliveryFailure(new AggregateError(
    failures,
    "one or more selected serving-target deltas lack exact terminal readback",
  ));
}

export async function executeRootSelectedProjectionDeltas(
  dependencies: ProjectionExecutorDependencies,
  context: ProjectionSourceContext,
  rootSelectedSelections: readonly ManagedTargetSelectionV2[],
  now: () => number,
  workerId: string,
  leaseMs: number,
): Promise<{ readonly receipt_ref: string }> {
  const deltaPort = dependencies.serving_target_delta;
  if (deltaPort === undefined) {
    projectionFail("PROJECTION_INPUT_INVALID", "Root-selected target execution requires the ACTIVE-delta port");
  }

  const initial = await prepareRootSelectedProjectionTargets({
    context,
    selections: rootSelectedSelections,
    base_profile: dependencies.profile,
    authority: dependencies.authority,
  });
  const active = initial.targets[0];
  if (active === undefined || active.role !== "ACTIVE") {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root-selected target list has no ACTIVE profile");
  }

  let states: ServingTargetExecutionState[] = initial.targets.map((prepared) => ({
    prepared,
    fence: null,
    terminal: prepared.prior_terminal,
    failure: null,
  }));
  const finish = () => {
    if (states.some((state) => state.failure !== null || state.terminal === null)) {
      servingTargetDeliveryFailure(states);
    }
    const activeTerminal = states[0]?.terminal;
    if (activeTerminal === null || activeTerminal === undefined) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "active serving-target terminal receipt is missing");
    }
    return { receipt_ref: activeTerminal.receipt_ref };
  };
  if (states.every((state) => state.terminal !== null)) return finish();

  const acquireAndBegin = async (pending: readonly ServingTargetExecutionState[]) => {
    for (const state of pending) {
      if (state.terminal !== null) continue;
      try {
        const acquiredAt = now();
        if (!Number.isSafeInteger(acquiredAt) || acquiredAt < 0) {
          projectionFail("PROJECTION_INPUT_INVALID", "projection clock is invalid");
        }
        const operationId = await stableProjectionId(
          "projection-execute",
          context.intent_ref.id,
          String(context.intent_ref.revision),
          state.prepared.execution_generation,
        );
        const lease = await dependencies.leases.acquire({
          operation_id: operationId,
          operation_kind: "PROJECTION_EXECUTE",
          lease_owner: workerId,
          now_ms: acquiredAt,
          lease_ms: leaseMs,
        });
        if (lease === null) {
          const terminal = await dependencies.authority.readTerminal(
            context,
            state.prepared.execution_generation,
            state.prepared.profile,
          );
          if (terminal !== null) {
            verifyServingTargetTerminalReceipt(terminal, state);
            state.terminal = terminal;
            continue;
          }
          throw new DeliveryRuntimeError(
            "DELIVERY_LEASE_LOST",
            "another worker owns the selected target projection generation",
            true,
          );
        }
        state.fence = {
          operation_id: lease.operation_id,
          lease_owner: lease.lease_owner,
          lease_generation: lease.lease_generation,
        };
        await dependencies.authority.begin(
          context,
          state.prepared.execution_generation,
          state.prepared.profile,
          state.fence,
        );
      } catch (error) {
        await reconcileServingTargetFailure(dependencies, context, state, error, now);
      }
    }
  };

  const settleShardedTargets = async (
    pending: readonly ServingTargetExecutionState[],
  ) => {
    await acquireAndBegin(pending);
    const started = pending.filter((state) => state.fence !== null && state.terminal === null);
    for (const state of started) {
      try {
        await settleServingTargetPartial(
          dependencies,
          context,
          state,
          "SHARDED_WORKFLOW_REQUIRED",
          now,
        );
      } catch (error) {
        await reconcileServingTargetFailure(dependencies, context, state, error, now);
      }
    }
    return finish();
  };

  const content = await dependencies.content.read(context, active.profile.maximum_markdown_bytes);
  if (content.disposition === "SHARDED_WORKFLOW_REQUIRED") {
    return settleShardedTargets(states);
  }

  const canonicalIdentity = await canonicalSourceProjectionIdentity(context, active.profile);
  for (const selected of initial.targets) {
    const identity = await canonicalSourceProjectionIdentity(context, selected.profile);
    if (
      identity.generation !== canonicalIdentity.generation ||
      identity.profile_sha256 !== canonicalIdentity.profile_sha256
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root-selected profiles do not share one canonical source identity");
    }
  }
  const projection = await projectNormalizedMarkdown({
    source_revision: context.source_revision,
    title: context.source_title,
    source_class: context.source_class,
    markdown: content.markdown,
    instruction_taint: context.instruction_taint,
    project_membership_ids: [],
    projection_generation: canonicalIdentity.generation,
    target_item_utf8_bytes: active.profile.target_item_utf8_bytes,
    max_item_utf8_bytes: active.profile.maximum_item_utf8_bytes,
  });
  if (projection.markdown_sha256 !== context.source_revision.content_sha256) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "projector readback digest differs from the admitted SourceRevision");
  }

  const prepared = await preflightRootSelectedProjectionTargets({
    context,
    projection_items: projection.items,
    prepared: initial,
  });
  states = prepared.targets.map((target) => ({
    prepared: target,
    fence: null,
    terminal: target.prior_terminal,
    failure: null,
  }));
  if (states.every((state) => state.terminal !== null)) return finish();

  await acquireAndBegin(states);
  if (states.every((state) => state.terminal !== null)) return finish();
  const started = states.filter((state) => state.fence !== null && state.terminal === null);
  if (started.length === 0) return finish();

  const sharded = started.filter((state) => state.prepared.requires_sharding);
  for (const state of sharded) {
    try {
      await settleServingTargetPartial(dependencies, context, state, "SHARDED_WORKFLOW_REQUIRED", now);
    } catch (error) {
      await reconcileServingTargetFailure(dependencies, context, state, error, now);
    }
  }
  const processable = started.filter((state) => !state.prepared.requires_sharding && state.failure === null);
  if (processable.length === 0) return finish();

  let canonicalMaterialization: {
    readonly work: ProjectionWorkReceipt;
    readonly source: CanonicalSourceProjectionReceipt;
  } | undefined;
  try {
    const resourceBounds = canonicalSourceResourceBounds(
      active.profile,
      content.size_bytes,
      projection.items,
    );
    const canonicalWork = await dependencies.work.materialize(
      {
        source_revision: context.source_revision,
        source_title: context.source_title,
        source_class: context.source_class,
        instruction_taint: context.instruction_taint,
      },
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
    canonicalMaterialization = { work: canonicalWork, source: canonicalSource };
  } catch (error) {
    for (const state of processable) {
      await reconcileServingTargetFailure(dependencies, context, state, error, now);
    }
    return finish();
  }
  if (canonicalMaterialization === undefined) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "canonical source materialization did not complete");
  }
  const { work: canonicalWork, source: canonicalSource } = canonicalMaterialization;

  const materialized = new Map<ServingTargetExecutionState, {
    readonly work: ProjectionWorkReceipt;
    readonly copy_plan: ManagedProjectCopyPlan;
  }>();
  for (const state of processable) {
    try {
      const preflight = state.prepared.preflight;
      if (preflight === null) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root-selected target plan is missing its preflight");
      }
      const copyPlan = await buildManagedProjectCopyPlan(
        context,
        state.prepared.profile,
        canonicalSource,
        projection.items,
      );
      if (!copyPlanMatchesPreflight(copyPlan, preflight)) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "complete Root-selected target effect set changed after preflight");
      }
      const projectCopyMapSet = await dependencies.work.materializeProjectCopyMapPages(
        canonicalSource,
        copyPlan.target,
        copyPlan.copies,
      );
      verifyProjectCopyMapSet(projectCopyMapSet, canonicalSource, copyPlan);
      const targetWork: ProjectionWorkReceipt = {
        ...canonicalWork,
        canonical_projection_generation: canonicalIdentity.generation,
        metadata_generation_digest: copyPlan.target.metadata_generation_digest,
        project_copy_map_set: projectCopyMapSet,
      };
      verifyWorkSet(targetWork, projection);
      const fence = state.fence;
      if (fence === null) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "selected target lost its execution fence before materialization");
      }
      await dependencies.authority.recordMaterialized(
        context,
        state.prepared.execution_generation,
        targetWork,
        fence,
      );
      materialized.set(state, { work: targetWork, copy_plan: copyPlan });
    } catch (error) {
      await reconcileServingTargetFailure(dependencies, context, state, error, now);
    }
  }
  if (materialized.size === 0) return finish();

  let d1Search: ProjectionSearchReceipt;
  try {
    d1Search = await dependencies.search.activate(context, canonicalIdentity.generation, projection);
    verifySearchSet(d1Search, projection, canonicalIdentity.generation);
  } catch (error) {
    for (const state of materialized.keys()) {
      await reconcileServingTargetFailure(dependencies, context, state, error, now);
    }
    return finish();
  }

  for (const [state, targetWork] of materialized) {
    try {
      const fence = state.fence;
      if (fence === null) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "selected target lost its execution fence before provider write");
      }
      const managed = await deltaPort.apply({
        selection: state.prepared.selection,
        profile: state.prepared.profile,
        context,
        execution_generation: state.prepared.execution_generation,
        canonical_projection_generation: canonicalIdentity.generation,
        canonical_source: canonicalSource,
        projection,
        copy_plan: targetWork.copy_plan,
        fence,
      });
      verifyServingTargetManagedReceipt(managed, state, targetWork.copy_plan);
      const settlement: ProjectionSettlement = {
        ...managedSettlement(managed, []),
        work: targetWork.work,
        d1_search: d1Search,
      };
      state.terminal = await dependencies.authority.settle(
        context,
        state.prepared.execution_generation,
        state.prepared.profile,
        settlement,
        fence,
      );
      verifyServingTargetTerminalReceipt(state.terminal, state);
      await completeServingTargetLeaseQuietly(dependencies, state, now);
    } catch (error) {
      await reconcileServingTargetFailure(dependencies, context, state, error, now);
    }
  }

  return finish();
}
