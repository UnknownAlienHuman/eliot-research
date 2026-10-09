import type { ExecutionFence } from "@eliotr/platform-cloudflare";
import { D1_EXECUTION_LEASE_NOW_SQL } from "@eliotr/platform-cloudflare";
import { MANAGED_ITEM_PROTOCOL_VERSION } from "./core-managed-item-receipts.js";
import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  projectionExecutionOperationId,
  projectionFail,
} from "./canonical.js";
import type {
  ProjectionExecutionProfile,
  ProjectionSourceContext,
} from "./types.js";
export interface GenerationRow {
  readonly job_id: unknown;
  readonly source_owner_generation: unknown;
  readonly content_sha256: unknown;
  readonly object_residency_key_digest: unknown;
  readonly projector_profile: unknown;
  readonly state: unknown;
  readonly item_count: unknown;
  readonly item_set_digest: unknown;
  readonly work_manifest_ref: unknown;
  readonly work_manifest_sha256: unknown;
  readonly d1_search_receipt_ref: unknown;
  readonly d1_search_readback_digest: unknown;
  readonly semantic_instance_id: unknown;
  readonly semantic_generation: unknown;
  readonly managed_item_protocol: unknown;
  readonly managed_target_instance_id: unknown;
  readonly managed_target_generation: unknown;
  readonly semantic_receipt_ref: unknown;
  readonly semantic_readback_digest: unknown;
  readonly reason_codes_json: unknown;
}

export function nowIso(clock: () => number): string {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    projectionFail("PROJECTION_INPUT_INVALID", "projection authority clock is invalid");
  }
  try {
    return new Date(value).toISOString();
  } catch (cause) {
    projectionFail(
      "PROJECTION_INPUT_INVALID",
      "projection authority clock cannot be represented",
      false,
      cause,
    );
  }
}

export async function generationRow(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
): Promise<GenerationRow | null> {
  return database.prepare(
    "SELECT job_id, source_owner_generation, content_sha256, object_residency_key_digest, " +
    "projector_profile, state, item_count, item_set_digest, work_manifest_ref, " +
    "work_manifest_sha256, d1_search_receipt_ref, d1_search_readback_digest, " +
    "semantic_instance_id, semantic_generation, managed_item_protocol, " +
    "managed_target_instance_id, managed_target_generation, semantic_receipt_ref, " +
    "semantic_readback_digest, reason_codes_json FROM projection_generation " +
    "WHERE source_revision_ref = ?1 AND projection_generation = ?2 LIMIT 1",
  ).bind(
    context.source_revision.source_revision_ref,
    projectionGeneration,
  ).first<GenerationRow>();
}

export function validateGenerationIdentity(
  row: GenerationRow,
  context: ProjectionSourceContext,
  profile: ProjectionExecutionProfile,
): void {
  if (
    row.job_id !== context.job_id ||
    row.source_owner_generation !== context.source_revision.source_owner_generation ||
    row.content_sha256 !== context.source_revision.content_sha256 ||
    row.object_residency_key_digest !== context.source_revision.object_residency_key_digest ||
    row.projector_profile !== profile.projector_profile
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "projection generation identity differs from durable source/job authority",
    );
  }
  if (row.managed_item_protocol === null) {
    if (
      row.managed_target_instance_id !== null ||
      row.managed_target_generation !== null ||
      row.semantic_instance_id !== profile.managed_instance_id ||
      row.semantic_generation !== profile.managed_generation
    ) {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "legacy projection generation is not bound to the requested managed target",
      );
    }
  } else if (row.managed_item_protocol === MANAGED_ITEM_PROTOCOL_VERSION) {
    if (
      row.managed_target_instance_id !== profile.managed_instance_id ||
      row.managed_target_generation !== profile.managed_generation
    ) {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "managed-item generation target differs from the immutable execution profile",
      );
    }
  } else {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "projection generation has an unknown managed-item protocol marker",
    );
  }
}

export async function assertManagedItemGenerationProtocol(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  profile?: ProjectionExecutionProfile,
): Promise<void> {
  const row = await database.prepare(
    "SELECT job_id, managed_item_protocol, managed_target_instance_id, " +
    "managed_target_generation FROM projection_generation WHERE source_revision_ref = ?1 " +
    "AND projection_generation = ?2 LIMIT 1",
  ).bind(
    context.source_revision.source_revision_ref,
    projectionGeneration,
  ).first<{
    readonly job_id: unknown;
    readonly managed_item_protocol: unknown;
    readonly managed_target_instance_id: unknown;
    readonly managed_target_generation: unknown;
  }>();
  if (
    row === null ||
    row.job_id !== context.job_id ||
    row.managed_item_protocol !== MANAGED_ITEM_PROTOCOL_VERSION
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed-item operation requires an explicitly versioned generation",
    );
  }
  const instanceId = assertProjectionIdentifier(
    row.managed_target_instance_id,
    "managed-item generation target instance",
  );
  const managedGeneration = assertProjectionIdentifier(
    row.managed_target_generation,
    "managed-item generation target generation",
  );
  if (
    profile !== undefined &&
    (instanceId !== profile.managed_instance_id ||
      managedGeneration !== profile.managed_generation)
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed-item generation target differs from the immutable execution profile",
    );
  }
}

export interface ProjectionExecutionFenceSnapshot {
  readonly operation_id: string;
  readonly lease_owner: string;
  readonly lease_generation: number;
  readonly now_ms: number;
}

export async function assertCurrentProjectionExecutionFence(
  database: D1Database,
  clock: () => number,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  fence: ExecutionFence,
): Promise<ProjectionExecutionFenceSnapshot> {
  const operationId = await projectionExecutionOperationId(context, projectionGeneration);
  const suppliedOperationId = assertProjectionIdentifier(
    fence.operation_id,
    "projection execution operation ID",
  );
  const leaseOwner = assertProjectionIdentifier(
    fence.lease_owner,
    "projection execution lease owner",
  );
  const leaseGeneration = assertProjectionInteger(
    fence.lease_generation,
    "projection execution lease generation",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (suppliedOperationId !== operationId) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "projection execution fence belongs to a different generation",
    );
  }
  const nowMs = clock();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    projectionFail("PROJECTION_INPUT_INVALID", "projection authority clock is invalid");
  }
  const row = await database.prepare(
    "SELECT operation_id, lease_until FROM operation_execution_lease WHERE operation_id=?1 " +
    "AND operation_kind='PROJECTION_EXECUTE' AND lease_owner=?2 " +
    "AND lease_generation=?3 AND state='LEASED' AND lease_until>?4 " +
    `AND lease_until>${D1_EXECUTION_LEASE_NOW_SQL} LIMIT 1`,
  ).bind(operationId, leaseOwner, leaseGeneration, nowMs).first<{
    readonly operation_id: unknown;
    readonly lease_until: unknown;
  }>();
  if (
    row === null ||
    row.operation_id !== operationId ||
    typeof row.lease_until !== "number" ||
    row.lease_until <= nowMs
  ) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "projection execution caller fence is no longer current",
      true,
    );
  }
  return {
    operation_id: operationId,
    lease_owner: leaseOwner,
    lease_generation: leaseGeneration,
    now_ms: nowMs,
  };
}
