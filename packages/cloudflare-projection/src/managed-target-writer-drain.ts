import {
  assertProjectionIdentifier,
  assertProjectionSha256,
  canonicalProjectionJson,
  projectionDigest,
  projectionSha256Utf8,
} from "./canonical.js";
import { createD1AiSearchGenerationRegistryStore } from "./ai-search-generation-registry-d1.js";
import { decodeAiSearchGenerationRegistrySnapshot } from "./ai-search-generation-registry-codec.js";
import {
  AiSearchGenerationRegistryError,
} from "./ai-search-generation-registry-contract.js";
import {
  MANAGED_GENERATION_PROMOTION_HOLD_PROTOCOL,
  type ManagedGenerationPromotionEvidenceAuthorityPort,
  type ManagedGenerationPromotionHoldRequest,
  type ManagedGenerationPromotionHoldV1,
  type ManagedGenerationPromotionTarget,
} from "./managed-generation-promotion-evidence-contract.js";
import { validateManagedGenerationPromotionHold } from "./managed-generation-promotion-evidence-validation.js";

type DrainPort = Pick<ManagedGenerationPromotionEvidenceAuthorityPort,
  "runWithTargetWriterDrain" | "assertTargetWriterDrainHold" | "reconcileTargetWriterDrain" | "reconcileAppliedQualification">;
type RegistryReadback = Parameters<DrainPort["reconcileTargetWriterDrain"]>[0]["registry_readback"];

interface HoldRow {
  readonly state: string;
  readonly managed_target_hold_json: string;
  readonly managed_target_hold_sha256: string;
  readonly managed_target_registry_readback_json: string | null;
}

interface TransitionRow extends RegistryReadback {
  readonly transition_json: string;
  readonly transition_sha256: string;
}

export interface D1ManagedTargetWriterDrainDependencies {
  readonly core_database: D1Database;
  readonly search_database: D1Database;
  /** Existing required-set producer, with current trusted-time policy validation. */
  readonly read_target_fence: (target: ManagedGenerationPromotionTarget) => Promise<string>;
  /** Atomically activate or block/retire the Core root under current authority after verified Search CAS. */
  readonly reconcile_core: (input: {
    readonly hold: ManagedGenerationPromotionHoldV1;
    readonly applied_registry_readback: RegistryReadback;
    readonly registry_readback: RegistryReadback;
  }) => Promise<void>;
}

function unavailable(message: string, cause?: unknown): never {
  throw new AiSearchGenerationRegistryError("AI_SEARCH_REGISTRY_DRAIN_UNCERTAIN", message,
    { retryable: true, ambiguous_effect: "WRITER_DRAIN", ...(cause === undefined ? {} : { cause }) });
}

function requestFor(hold: ManagedGenerationPromotionHoldV1): ManagedGenerationPromotionHoldRequest {
  return { operation_id: hold.operation_id, operation: hold.operation, targets: hold.targets };
}

function identity(row: RegistryReadback): RegistryReadback {
  return { namespace: row.namespace, revision: row.revision, artifact_sha256: row.artifact_sha256,
    active_head_generation: row.active_head_generation };
}

/**
 * Cross-D1 completion is reconciled, never described as one transaction. The
 * Core hold survives worker/lease expiry, exceptions and missing Search ACKs.
 */
export function createD1ManagedTargetWriterDrain(dependencies: D1ManagedTargetWriterDrainDependencies): DrainPort {
  const core = dependencies.core_database;
  const search = dependencies.search_database;
  const registry = createD1AiSearchGenerationRegistryStore(search);

  async function rowFor(operationId: string): Promise<HoldRow | null> {
    return core.prepare("SELECT state,managed_target_hold_json,managed_target_hold_sha256," +
      "managed_target_registry_readback_json FROM operation_execution_lease " +
      "WHERE operation_id=?1 AND operation_kind='MANAGED_TARGET_PROMOTION' LIMIT 1")
      .bind(operationId).first<HoldRow>();
  }

  async function decodeHold(row: HoldRow, request: ManagedGenerationPromotionHoldRequest): Promise<ManagedGenerationPromotionHoldV1> {
    const hold = await validateManagedGenerationPromotionHold(JSON.parse(row.managed_target_hold_json) as unknown, request);
    if (row.managed_target_hold_sha256 !== hold.hold_sha256 ||
        canonicalProjectionJson(hold) !== row.managed_target_hold_json) unavailable("stored writer hold bytes changed");
    return hold;
  }

  async function assertHeld(hold: ManagedGenerationPromotionHoldV1, recheckFence = true): Promise<void> {
    const row = await rowFor(hold.operation_id);
    if (row === null || row.state !== "LEASED" || row.managed_target_registry_readback_json !== null ||
        canonicalProjectionJson(await decodeHold(row, requestFor(hold))) !== canonicalProjectionJson(hold)) {
      unavailable("target writer hold is absent, released, or belongs to different authority");
    }
    for (const entry of hold.targets) {
      const pending = await core.prepare("SELECT COUNT(*) AS count FROM projection_managed_item_effect " +
        "WHERE managed_instance_id=?1 AND managed_generation=?2 AND state<>'READBACK_VERIFIED'")
        .bind(entry.target.managed_instance_id, entry.target.managed_generation).first<{ count: number }>();
      if (pending?.count !== 0 || (recheckFence && await dependencies.read_target_fence(entry.target) !== entry.target_fence_sha256)) {
        unavailable("target writers or current target authority changed under the hold");
      }
    }
  }

  async function acquire(request: ManagedGenerationPromotionHoldRequest): Promise<ManagedGenerationPromotionHoldV1> {
    assertProjectionIdentifier(request.operation_id, "promotion operation");
    if (!["QUALIFY", "PROMOTE", "ROLLBACK"].includes(request.operation) || request.targets.length < 1 || request.targets.length > 2 ||
        new Set(request.targets.map(({ target }) => `${target.managed_instance_id}\0${target.managed_generation}`)).size !== request.targets.length ||
        request.targets.some(({ target }) => target.namespace !== request.targets[0]?.target.namespace)) {
      unavailable("writer hold must cover one or two distinct targets in one registry namespace");
    }
    const prior = await rowFor(request.operation_id);
    if (prior !== null) {
      const hold = await decodeHold(prior, request);
      await assertHeld(hold);
      return hold;
    }
    const clock = await core.prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS now_ms")
      .first<{ now_ms: number }>();
    if (clock === null || !Number.isSafeInteger(clock.now_ms) || clock.now_ms <= 0) unavailable("trusted Core clock is unavailable");
    const targets: ManagedGenerationPromotionHoldV1["targets"][number][] = [];
    for (const entry of request.targets) {
      const fence = await dependencies.read_target_fence(entry.target);
      assertProjectionSha256(fence, "current target fence");
      if (entry.target_fence_sha256 !== undefined && entry.target_fence_sha256 !== fence) unavailable("requested target fence is stale");
      const epoch = await projectionDigest({ operation_id: request.operation_id, target: entry.target, target_fence_sha256: fence });
      const receiptRef = `managed-target-drain/${epoch}`;
      const receiptSha = await projectionDigest({ target: entry.target, target_fence_sha256: fence,
        writer_epoch: epoch, outstanding_writer_count: 0, receipt_ref: receiptRef });
      targets.push({ target: entry.target, target_fence_sha256: fence, writer_epoch: epoch,
        outstanding_writer_count: 0, receipt_ref: receiptRef, receipt_sha256: receiptSha });
    }
    const base = { protocol: MANAGED_GENERATION_PROMOTION_HOLD_PROTOCOL, operation_id: request.operation_id,
      operation: request.operation, state: "HELD" as const, held_at: new Date(clock.now_ms).toISOString(), targets };
    const proposed = { ...base, hold_sha256: await projectionDigest(base) };
    const hold = await validateManagedGenerationPromotionHold(proposed, request);
    try {
      await core.prepare("INSERT INTO operation_execution_lease " +
        "(operation_id,operation_kind,lease_owner,lease_generation,lease_until,attempt,state,created_at,updated_at," +
        "managed_target_hold_json,managed_target_hold_sha256) " +
        "VALUES (?1,'MANAGED_TARGET_PROMOTION',?1,1,?2,1,'LEASED',?3,?3,?4,?5) " +
        "ON CONFLICT(operation_id) DO NOTHING")
        .bind(request.operation_id, clock.now_ms + 60_000, clock.now_ms, canonicalProjectionJson(hold), hold.hold_sha256).run();
    } catch (cause) {
      unavailable("target hold could not atomically exclude pending or concurrent writers", cause);
    }
    const stored = await rowFor(request.operation_id);
    if (stored === null) unavailable("writer hold acquisition has no durable readback");
    const acquired = await decodeHold(stored, request);
    await assertHeld(acquired);
    return acquired;
  }

  async function findApplied(operationId: string): Promise<TransitionRow> {
    const result = await search.prepare("SELECT namespace,revision,artifact_sha256,active_head_generation," +
      "transition_json,transition_sha256 FROM ai_search_generation_registry_transition " +
      "WHERE json_extract(transition_json,'$.promotion_hold.operation_id')=?1 ORDER BY revision LIMIT 2")
      .bind(operationId).all<TransitionRow>();
    if (result.success !== true || result.results.length !== 1 || result.results[0] === undefined) {
      unavailable("operation has no unique committed Search transition");
    }
    return result.results[0];
  }

  async function reconcile(input: Parameters<DrainPort["reconcileTargetWriterDrain"]>[0]): Promise<void> {
    assertProjectionIdentifier(input.operation_id, "promotion reconciliation operation");
    const row = await rowFor(input.operation_id);
    if (row === null) unavailable("promotion reconciliation has no durable Core hold");
    const applied = await findApplied(input.operation_id);
    if (applied.transition_json.length > 786432 ||
        await projectionSha256Utf8(applied.transition_json) !== applied.transition_sha256) {
      unavailable("requested registry readback is not this operation's exact committed Search transition");
    }
    const event = JSON.parse(applied.transition_json) as Record<string, unknown>;
    const rawHold = JSON.parse(row.managed_target_hold_json) as ManagedGenerationPromotionHoldV1;
    const hold = await decodeHold(row, requestFor(rawHold));
    if (canonicalProjectionJson(event) !== applied.transition_json ||
        event.protocol !== "eliotr.ai-search-generation-registry-transition.v1" ||
        event.namespace !== applied.namespace || event.revision !== applied.revision ||
        event.artifact_sha256 !== applied.artifact_sha256 || event.active_head_generation !== applied.active_head_generation ||
        event.operation !== hold.operation || canonicalProjectionJson(event.promotion_hold) !== canonicalProjectionJson(hold)) {
      unavailable("Search transition does not retain the exact Core writer hold");
    }
    const current = await decodeAiSearchGenerationRegistrySnapshot(await registry.read(applied.namespace), applied.namespace);
    const currentIdentity: RegistryReadback = { namespace: current.artifact.namespace,
      revision: current.artifact.revision, artifact_sha256: current.artifact_sha256,
      active_head_generation: current.artifact.registry.active_head_generation };
    if (current.artifact.revision < applied.revision ||
        (current.artifact.revision === applied.revision &&
          canonicalProjectionJson(currentIdentity) !== canonicalProjectionJson(identity(applied))) ||
        ![canonicalProjectionJson(identity(applied)), canonicalProjectionJson(currentIdentity)]
          .includes(canonicalProjectionJson(input.registry_readback))) {
      unavailable("registry readback is neither this committed transition nor the actual current Search artifact");
    }
    const readbackJson = canonicalProjectionJson(identity(applied));
    if (row.state === "COMPLETED") {
      if (row.managed_target_registry_readback_json !== readbackJson) unavailable("completed hold has a different registry readback");
      return;
    }
    // Authority may have changed after Search committed. The Core reconciler
    // must then block/retire that exact root instead of activating stale data.
    await assertHeld(hold, false);
    // The immutable applied identity and independently decoded current identity
    // are distinct: unrelated DECLAREs may advance the namespace after this CAS.
    await dependencies.reconcile_core({ hold, applied_registry_readback: identity(applied), registry_readback: currentIdentity });
    await assertHeld(hold, false);
    await core.prepare("UPDATE operation_execution_lease SET state='COMPLETED'," +
      "managed_target_registry_readback_json=?3,terminal_receipt_ref=?4," +
      "updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) " +
      "WHERE operation_id=?1 AND state='LEASED' AND managed_target_hold_sha256=?2")
      .bind(hold.operation_id, hold.hold_sha256, readbackJson, `search-registry/${applied.namespace}/${applied.revision}/${applied.artifact_sha256}`).run();
    const completed = await rowFor(hold.operation_id);
    if (completed?.state !== "COMPLETED" || completed.managed_target_registry_readback_json !== readbackJson) {
      unavailable("Core reconciliation completion has no exact durable readback");
    }
  }

  return {
    async runWithTargetWriterDrain<T>(request: ManagedGenerationPromotionHoldRequest,
      commit: (hold: ManagedGenerationPromotionHoldV1) => Promise<T>): Promise<T> {
      const hold = await acquire(request);
      const result = await commit(hold);
      // Success alone is not evidence: independently locate and decode the CAS.
      const applied = await findApplied(hold.operation_id);
      await reconcile({ operation_id: hold.operation_id, registry_readback: identity(applied) });
      return result;
    },
    assertTargetWriterDrainHold: assertHeld,
    reconcileTargetWriterDrain: reconcile,
    async reconcileAppliedQualification(input): Promise<boolean> {
      assertProjectionSha256(input.evidence_sha256, "retained qualification evidence");
      const rows = await search.prepare("SELECT transition_json FROM ai_search_generation_registry_transition t " +
        "WHERE namespace=?1 AND operation='QUALIFY' AND generation=?2 " +
        "AND EXISTS (SELECT 1 FROM json_each(t.transition_json,'$.changed_generations') c " +
        "WHERE json_extract(c.value,'$.generation')=?2 AND json_extract(c.value,'$.next_evidence_sha256')=?3) " +
        "ORDER BY revision DESC LIMIT 2")
        .bind(input.target.namespace, input.target.managed_generation, input.evidence_sha256)
        .all<{ transition_json: string }>();
      if (rows.success !== true || rows.results.length > 1) unavailable("qualification recovery transition is unavailable or ambiguous");
      const transition = rows.results[0];
      if (transition === undefined) return false;
      const event = JSON.parse(transition.transition_json) as { promotion_hold?: { operation_id?: unknown } };
      const operationId = event.promotion_hold?.operation_id;
      if (typeof operationId !== "string") unavailable("qualification recovery transition lacks its hold identity");
      const row = await rowFor(operationId);
      if (row === null || row.state === "COMPLETED") return false;
      await reconcile({ operation_id: operationId, registry_readback: input.registry_readback });
      return true;
    },
  };
}
