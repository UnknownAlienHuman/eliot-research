import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  assertProjectionSha256,
  canonicalProjectionJson,
  projectionExecutionOperationId,
  projectionDigest,
  projectionFail,
} from "./canonical.js";
import {
  D1_EXECUTION_LEASE_NOW_SQL,
  type ExecutionFence,
} from "@eliotr/platform-cloudflare";
import {
  assertLineage,
  assertManagedItemIntent,
  decodeEffectRow,
  type ManagedItemEffect,
  type ManagedItemEffectRow,
  type ManagedItemIntent,
  type ManagedItemReceipt,
} from "./core-managed-item-intent.js";
import type {
  ProjectionExecutionProfile,
  ProjectionSourceContext,
} from "./types.js";

interface ExecutionLeaseRow {
  readonly operation_id: unknown;
  readonly operation_kind: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
  readonly state: unknown;
}

function readClock(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    projectionFail("PROJECTION_INPUT_INVALID", "projection authority clock is invalid");
  }
  return value;
}

function nowIso(clock: () => number): string {
  const value = readClock(clock);
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

function assertCallerFenceInput(
  operationId: string,
  callerFence: ExecutionFence,
): void {
  if (callerFence.operation_id !== operationId) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed item caller fence belongs to a different projection operation",
    );
  }
  assertProjectionIdentifier(callerFence.lease_owner, "projection lease owner");
  assertProjectionInteger(
    callerFence.lease_generation,
    "projection lease generation",
    1,
    Number.MAX_SAFE_INTEGER,
  );
}

async function assertCallerFence(
  database: D1Database,
  operationId: string,
  callerFence: ExecutionFence,
  nowMs: number,
): Promise<void> {
  assertCallerFenceInput(operationId, callerFence);
  const row = await database.prepare(
    "SELECT operation_id, operation_kind, lease_owner, lease_generation, lease_until, state " +
    "FROM operation_execution_lease WHERE operation_id = ?1 AND lease_until > " +
    D1_EXECUTION_LEASE_NOW_SQL + " LIMIT 1",
  ).bind(callerFence.operation_id).first<ExecutionLeaseRow>();
  if (
    row === null ||
    row.operation_id !== callerFence.operation_id ||
    row.operation_kind !== "PROJECTION_EXECUTE" ||
    row.lease_owner !== callerFence.lease_owner ||
    row.lease_generation !== callerFence.lease_generation ||
    row.state !== "LEASED" ||
    typeof row.lease_until !== "number" ||
    row.lease_until <= nowMs
  ) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "managed item effect has no current projection execution lease",
      true,
    );
  }
}

async function loadEffectRow(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  itemKey: string,
): Promise<ManagedItemEffectRow | null> {
  return database.prepare(
    "SELECT source_revision_ref, projection_generation, job_id, item_key, desired_index, " +
    "normalized_start_byte, normalized_end_byte, " +
    "intent_id, intent_revision, attempt_id, execution_operation_id, dispatch_lease_generation, " +
    "managed_instance_id, managed_generation, provider_source, provider_key, " +
    "section_content_sha256, document_sha256, document_size_bytes, metadata_json, state, " +
    "provider_item_id, readback_receipt_json, readback_sha256 " +
    "FROM projection_managed_item_effect WHERE source_revision_ref = ?1 " +
    "AND projection_generation = ?2 AND job_id = ?3 AND item_key = ?4 LIMIT 1",
  ).bind(
    context.source_revision.source_revision_ref,
    projectionGeneration,
    context.job_id,
    itemKey,
  ).first<ManagedItemEffectRow>();
}

export async function prepareManagedItemEffects(
  database: D1Database,
  clock: () => number,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  profile: ProjectionExecutionProfile,
  items: readonly ManagedItemIntent[],
  callerFence: ExecutionFence,
): Promise<readonly ManagedItemEffect[]> {
  if (
    items.length < 1 ||
    items.length > profile.maximum_synchronous_items ||
    new Set(items.map((item) => item.item_key)).size !== items.length
  ) {
    projectionFail("PROJECTION_INPUT_INVALID", "managed item intent set is empty, oversized, or duplicated");
  }
  const operationId = await projectionExecutionOperationId(context, projectionGeneration);
  assertCallerFenceInput(operationId, callerFence);
  await assertCallerFence(database, operationId, callerFence, readClock(clock));
  const generation = await database.prepare(
    "SELECT job_id, state, item_count, item_set_digest FROM projection_generation WHERE source_revision_ref = ?1 " +
    "AND projection_generation = ?2 LIMIT 1",
  ).bind(context.source_revision.source_revision_ref, projectionGeneration)
    .first<{
      readonly job_id: unknown;
      readonly state: unknown;
      readonly item_count: unknown;
      readonly item_set_digest: unknown;
    }>();
  if (
    generation === null ||
    generation.job_id !== context.job_id ||
    generation.state !== "MATERIALIZED" ||
    generation.item_count !== items.length
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed item intents require the exact materialized projection generation",
    );
  }
  const expectedItemSetDigest = assertProjectionSha256(
    generation.item_set_digest,
    "managed materialized item set digest",
  );
  const actualItemSetDigest = await projectionDigest(items.map((item, index) => {
    assertManagedItemIntent(context, projectionGeneration, profile, item, index);
    return {
      item_key: item.item_key,
      canonical_section_id: item.metadata.canonical_section_id,
      content_sha256: item.section_content_sha256,
      start: item.normalized_start_byte,
      end: item.normalized_end_byte,
    };
  }));
  if (actualItemSetDigest !== expectedItemSetDigest) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed item intents differ from the exact durable projection manifest item set",
    );
  }
  for (const item of items) {
    const mutationNowMs = readClock(clock);
    await assertCallerFence(database, operationId, callerFence, mutationNowMs);
    const now = nowIso(() => mutationNowMs);
    await database.prepare(
      "INSERT INTO projection_managed_item_effect(" +
      "source_revision_ref, projection_generation, job_id, item_key, desired_index, " +
      "normalized_start_byte, normalized_end_byte, " +
      "intent_id, intent_revision, attempt_id, execution_operation_id, " +
      "dispatch_lease_generation, managed_instance_id, managed_generation, provider_source, " +
      "provider_key, section_content_sha256, document_sha256, document_size_bytes, metadata_json, " +
      "state, provider_item_id, readback_receipt_json, readback_sha256, created_at, updated_at) " +
      "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL,?12,?13,'builtin',?14,?15,?16,?17,?18, " +
      "'INTENT',NULL,NULL,NULL,?19,?19 WHERE EXISTS (SELECT 1 FROM operation_execution_lease l " +
      "WHERE l.operation_id = ?20 AND l.operation_kind = 'PROJECTION_EXECUTE' " +
      "AND l.lease_owner = ?21 AND l.lease_generation = ?22 AND l.state = 'LEASED' " +
      "AND l.lease_until > ?23 AND l.lease_until > " + D1_EXECUTION_LEASE_NOW_SQL +
      ") ON CONFLICT(source_revision_ref,projection_generation,item_key) " +
      "DO NOTHING",
    ).bind(
      context.source_revision.source_revision_ref,
      projectionGeneration,
      context.job_id,
      item.item_key,
      item.desired_index,
      item.normalized_start_byte,
      item.normalized_end_byte,
      context.intent_ref.id,
      context.intent_ref.revision,
      context.acceptance_attempt_id,
      operationId,
      profile.managed_instance_id,
      profile.managed_generation,
      item.provider_key,
      item.section_content_sha256,
      item.document_sha256,
      item.document_size_bytes,
      canonicalProjectionJson(item.metadata),
      now,
      callerFence.operation_id,
      callerFence.lease_owner,
      callerFence.lease_generation,
      mutationNowMs,
    ).run();
    await assertCallerFence(database, operationId, callerFence, readClock(clock));
  }
  const output: ManagedItemEffect[] = [];
  for (const item of items) {
    const row = await loadEffectRow(database, context, projectionGeneration, item.item_key);
    if (row === null) {
      projectionFail(
        "PROJECTION_SETTLEMENT_UNCERTAIN",
        "managed item intent was not durably read back",
        true,
      );
    }
    output.push(decodeEffectRow(row, context, projectionGeneration, profile, operationId, item));
  }
  await assertCallerFence(database, operationId, callerFence, readClock(clock));
  return Object.freeze(output);
}

export async function beginManagedItemDispatch(
  database: D1Database,
  clock: () => number,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  itemKey: string,
  callerFence: ExecutionFence,
): Promise<boolean> {
  const operationId = await projectionExecutionOperationId(context, projectionGeneration);
  assertCallerFenceInput(operationId, callerFence);
  const nowMs = readClock(clock);
  await assertCallerFence(database, operationId, callerFence, nowMs);
  const result = await database.prepare(
    "UPDATE projection_managed_item_effect SET state = 'DISPATCHED', " +
    "dispatch_lease_generation = ?5, updated_at = ?6 " +
    "WHERE source_revision_ref = ?1 AND projection_generation = ?2 AND job_id = ?3 " +
    "AND item_key = ?4 AND state = 'INTENT' AND dispatch_lease_generation IS NULL " +
    "AND execution_operation_id = ?7 AND EXISTS (SELECT 1 FROM operation_execution_lease l " +
    "WHERE l.operation_id = ?7 AND l.operation_kind = 'PROJECTION_EXECUTE' " +
    "AND l.lease_owner = ?9 AND l.lease_generation = ?5 AND l.state = 'LEASED' " +
    "AND l.lease_until > ?8 AND l.lease_until > " + D1_EXECUTION_LEASE_NOW_SQL + ")",
  ).bind(
    context.source_revision.source_revision_ref,
    projectionGeneration,
    context.job_id,
    itemKey,
    callerFence.lease_generation,
    nowIso(() => nowMs),
    operationId,
    nowMs,
    callerFence.lease_owner,
  ).run();
  if (result.meta.changes === 1) {
    await assertCallerFence(database, operationId, callerFence, readClock(clock));
    return true;
  }
  const row = await loadEffectRow(database, context, projectionGeneration, itemKey);
  await assertCallerFence(database, operationId, callerFence, readClock(clock));
  if (row === null) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item intent is missing before dispatch");
  }
  assertLineage(row, context, projectionGeneration, operationId);
  if (row.state === "INTENT") {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "managed item dispatch was not fenced by the current execution lease",
      true,
    );
  }
  return false;
}

export async function recordManagedItemProviderId(
  database: D1Database,
  clock: () => number,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  itemKey: string,
  providerItemId: string,
  callerFence: ExecutionFence,
): Promise<void> {
  const operationId = await projectionExecutionOperationId(context, projectionGeneration);
  assertCallerFenceInput(operationId, callerFence);
  await assertCallerFence(database, operationId, callerFence, readClock(clock));
  const id = assertProjectionIdentifier(providerItemId, "provider item ID");
  const row = await loadEffectRow(database, context, projectionGeneration, itemKey);
  if (row === null) projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item intent is missing");
  assertLineage(row, context, projectionGeneration, operationId);
  if (row.state === "INTENT") {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "provider acknowledgement preceded durable dispatch");
  }
  if (row.provider_item_id !== null && row.provider_item_id !== id) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "provider item ID changed for an exact key");
  }
  if (row.provider_item_id === null) {
    const mutationNowMs = readClock(clock);
    await assertCallerFence(database, operationId, callerFence, mutationNowMs);
    const now = nowIso(() => mutationNowMs);
    await database.prepare(
      "UPDATE projection_managed_item_effect SET provider_item_id = ?5, updated_at = ?6 " +
      "WHERE source_revision_ref = ?1 AND projection_generation = ?2 AND job_id = ?3 " +
      "AND item_key = ?4 AND state IN ('DISPATCHED','UNKNOWN') AND provider_item_id IS NULL " +
      "AND execution_operation_id = ?7 AND EXISTS (SELECT 1 FROM operation_execution_lease l " +
      "WHERE l.operation_id = ?7 AND l.operation_kind = 'PROJECTION_EXECUTE' " +
      "AND l.lease_owner = ?8 AND l.lease_generation = ?9 AND l.state = 'LEASED' " +
      "AND l.lease_until > ?10 AND l.lease_until > " + D1_EXECUTION_LEASE_NOW_SQL + ")",
    ).bind(
      context.source_revision.source_revision_ref,
      projectionGeneration,
      context.job_id,
      itemKey,
      id,
      now,
      operationId,
      callerFence.lease_owner,
      callerFence.lease_generation,
      mutationNowMs,
    ).run();
  }
  const readback = await loadEffectRow(database, context, projectionGeneration, itemKey);
  await assertCallerFence(database, operationId, callerFence, readClock(clock));
  if (readback === null || readback.provider_item_id !== id) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "provider item ID intent readback is missing or inconsistent",
      true,
    );
  }
}

export async function markManagedItemUnknown(
  database: D1Database,
  clock: () => number,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  itemKey: string,
  callerFence: ExecutionFence,
): Promise<void> {
  const operationId = await projectionExecutionOperationId(context, projectionGeneration);
  assertCallerFenceInput(operationId, callerFence);
  const mutationNowMs = readClock(clock);
  await assertCallerFence(database, operationId, callerFence, mutationNowMs);
  const now = nowIso(() => mutationNowMs);
  await database.prepare(
    "UPDATE projection_managed_item_effect SET state = 'UNKNOWN', updated_at = ?5 " +
    "WHERE source_revision_ref = ?1 AND projection_generation = ?2 AND job_id = ?3 " +
    "AND item_key = ?4 AND state = 'DISPATCHED' AND execution_operation_id = ?6 " +
    "AND EXISTS (SELECT 1 FROM operation_execution_lease l WHERE l.operation_id = ?6 " +
    "AND l.operation_kind = 'PROJECTION_EXECUTE' AND l.lease_owner = ?7 " +
    "AND l.lease_generation = ?8 AND l.state = 'LEASED' AND l.lease_until > ?9 " +
    "AND l.lease_until > " + D1_EXECUTION_LEASE_NOW_SQL + ")",
  ).bind(
    context.source_revision.source_revision_ref,
    projectionGeneration,
    context.job_id,
    itemKey,
    now,
    operationId,
    callerFence.lease_owner,
    callerFence.lease_generation,
    mutationNowMs,
  ).run();
  const row = await loadEffectRow(database, context, projectionGeneration, itemKey);
  await assertCallerFence(database, operationId, callerFence, readClock(clock));
  if (row === null) projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item intent is missing");
  assertLineage(row, context, projectionGeneration, operationId);
  if (row.state !== "UNKNOWN" && row.state !== "READBACK_VERIFIED") {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item cannot be marked unknown from this state");
  }
}

export async function recordManagedItemReceipt(
  database: D1Database,
  clock: () => number,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  receipt: ManagedItemReceipt,
  callerFence: ExecutionFence,
): Promise<void> {
  const operationId = await projectionExecutionOperationId(context, projectionGeneration);
  assertCallerFenceInput(operationId, callerFence);
  await assertCallerFence(database, operationId, callerFence, readClock(clock));
  const itemKey = assertProjectionIdentifier(receipt.item_key, "managed receipt item key");
  const providerId = assertProjectionIdentifier(receipt.provider_item_id, "managed receipt provider ID");
  assertProjectionIdentifier(receipt.provider_key, "managed receipt provider key");
  assertProjectionInteger(receipt.file_size, "managed receipt file size", 1, 4 * 1024 * 1024);
  assertProjectionInteger(receipt.chunks_count, "managed receipt chunks", 1, 1_000_000);
  assertProjectionSha256(receipt.content_sha256, "managed receipt content digest");
  assertProjectionSha256(receipt.readback_sha256, "managed receipt readback digest");
  const row = await loadEffectRow(database, context, projectionGeneration, itemKey);
  if (row === null) projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item intent is missing");
  assertLineage(row, context, projectionGeneration, operationId);
  if (
    row.provider_key !== receipt.provider_key ||
    row.document_sha256 !== receipt.content_sha256 ||
    row.document_size_bytes !== receipt.file_size ||
    (row.provider_item_id !== null && row.provider_item_id !== providerId) ||
    (row.state !== "DISPATCHED" && row.state !== "UNKNOWN" && row.state !== "READBACK_VERIFIED")
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed readback receipt differs from its intent");
  }
  const receiptJson = canonicalProjectionJson(receipt);
  if (row.state === "READBACK_VERIFIED") {
    if (row.readback_receipt_json !== receiptJson || row.readback_sha256 !== receipt.readback_sha256) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item receipt is immutable");
    }
    await assertCallerFence(database, operationId, callerFence, readClock(clock));
    return;
  }
  const mutationNowMs = readClock(clock);
  await assertCallerFence(database, operationId, callerFence, mutationNowMs);
  const now = nowIso(() => mutationNowMs);
  await database.prepare(
    "UPDATE projection_managed_item_effect SET state = 'READBACK_VERIFIED', " +
    "provider_item_id = COALESCE(provider_item_id, ?5), readback_receipt_json = ?6, " +
    "readback_sha256 = ?7, updated_at = ?8 WHERE source_revision_ref = ?1 " +
    "AND projection_generation = ?2 AND job_id = ?3 AND item_key = ?4 " +
    "AND state IN ('DISPATCHED','UNKNOWN') AND (provider_item_id IS NULL OR provider_item_id = ?5) " +
    "AND execution_operation_id = ?9 AND EXISTS (SELECT 1 FROM operation_execution_lease l " +
    "WHERE l.operation_id = ?9 AND l.operation_kind = 'PROJECTION_EXECUTE' " +
    "AND l.lease_owner = ?10 AND l.lease_generation = ?11 AND l.state = 'LEASED' " +
    "AND l.lease_until > ?12 AND l.lease_until > " + D1_EXECUTION_LEASE_NOW_SQL + ")",
  ).bind(
    context.source_revision.source_revision_ref,
    projectionGeneration,
    context.job_id,
    itemKey,
    providerId,
    receiptJson,
    receipt.readback_sha256,
    now,
    operationId,
    callerFence.lease_owner,
    callerFence.lease_generation,
    mutationNowMs,
  ).run();
  const readback = await loadEffectRow(database, context, projectionGeneration, itemKey);
  await assertCallerFence(database, operationId, callerFence, readClock(clock));
  if (
    readback === null ||
    readback.state !== "READBACK_VERIFIED" ||
    readback.provider_item_id !== providerId ||
    readback.readback_receipt_json !== receiptJson ||
    readback.readback_sha256 !== receipt.readback_sha256
  ) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "managed item receipt did not settle exactly",
      true,
    );
  }
}
