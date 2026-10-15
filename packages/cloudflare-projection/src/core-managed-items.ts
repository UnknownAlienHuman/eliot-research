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
import { managedProjectGenerationMetadataValue } from "./managed-project-path.js";
import type {
  ManagedProjectCopyPlan,
  ProjectionExecutionProfile,
  ProjectionSourceContext,
} from "./types.js";

const MAX_MANAGED_PROJECT_MEMBERSHIPS = 256;

interface ExecutionLeaseRow {
  readonly operation_id: unknown;
  readonly operation_kind: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
  readonly state: unknown;
}

function dispatchAuthorityPredicate(start: number): string {
  const p = (offset: number) => `?${start + offset}`;
  return "EXISTS (SELECT 1 FROM outbox o " +
    "JOIN operation_intent i ON i.intent_id = o.intent_id AND i.revision = o.intent_revision " +
    "JOIN job j ON j.intent_id = i.intent_id AND j.intent_revision = i.revision " +
    "JOIN source_revision sr ON sr.source_revision_ref = i.payload_ref " +
    "JOIN source s ON s.source_id = sr.source_id " +
    "JOIN source_namespace_ownership own ON own.source_namespace_id = s.source_namespace_id " +
    "AND own.owner_system_id = s.source_owner_system_id " +
    "AND own.source_owner_generation = sr.source_owner_generation " +
    "JOIN source_admission_decision decision ON decision.decision_receipt_ref = i.policy_decision_ref " +
    "AND decision.source_revision_ref = sr.source_revision_ref " +
    "AND decision.source_owner_generation = sr.source_owner_generation " +
    "JOIN projection_generation g ON g.source_revision_ref = sr.source_revision_ref " +
    `AND g.projection_generation = ${p(8)} AND g.job_id = j.job_id ` +
    `WHERE o.outbox_id = ${p(0)} AND o.topic = ${p(1)} ` +
    `AND o.payload_ref = ${p(2)} AND o.payload_sha256 = ${p(3)} ` +
    `AND i.idempotency_key = ${p(4)} AND i.intent_id = ${p(5)} ` +
    `AND i.revision = ${p(6)} AND i.operation_kind = 'PROJECTION' ` +
    `AND j.job_id = ${p(7)} AND j.state = 'RUNNING' ` +
    `AND sr.source_revision_ref = ${p(9)} AND sr.source_id = ${p(10)} ` +
    `AND sr.source_owner_generation = ${p(13)} AND sr.content_sha256 = ${p(14)} ` +
    `AND sr.object_residency_key_digest = ${p(15)} AND sr.purge_state = 'LIVE' ` +
    `AND s.source_namespace_id = ${p(11)} AND s.source_owner_system_id = ${p(12)} ` +
    `AND s.source_owner_generation = ${p(13)} AND s.ownership_mode = ${p(16)} ` +
    "AND own.status = 'ACTIVE' " +
    `AND decision.source_namespace_id = ${p(11)} ` +
    `AND decision.owner_system_id = ${p(12)} ` +
    `AND decision.object_residency_key_digest = ${p(15)} ` +
    "AND decision.decision = 'ADMITTED' " +
    "AND g.state = 'MATERIALIZED' " +
    "AND (SELECT COUNT(*) FROM job sibling WHERE sibling.intent_id = i.intent_id " +
    "AND sibling.intent_revision = i.revision) = 1 " +
    "AND NOT EXISTS (SELECT 1 FROM projection_terminal_guard terminal " +
    "WHERE terminal.source_revision_ref = sr.source_revision_ref " +
    "AND terminal.projection_generation = g.projection_generation))";
}

function dispatchAuthorityBindings(
  context: ProjectionSourceContext,
  projectionGeneration: string,
): readonly (string | number)[] {
  return [
    context.message.outbox_id,
    context.message.topic,
    context.message.payload_ref,
    context.message.payload_sha256,
    context.message.idempotency_key,
    context.intent_ref.id,
    context.intent_ref.revision,
    context.job_id,
    projectionGeneration,
    context.source_revision.source_revision_ref,
    context.source_revision.source_id,
    context.source_revision.source_namespace_id,
    context.source_revision.source_owner_system_id,
    context.source_revision.source_owner_generation,
    context.source_revision.content_sha256,
    context.source_revision.object_residency_key_digest,
    context.source_revision.ownership_mode,
  ];
}

async function assertCurrentManagedDispatchAuthority(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
): Promise<void> {
  const row = await database.prepare(
    `SELECT 1 AS current_authority WHERE ${dispatchAuthorityPredicate(1)}`,
  ).bind(...dispatchAuthorityBindings(context, projectionGeneration))
    .first<{ readonly current_authority: unknown }>();
  if (row === null) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "pinned source or projection generation is no longer dispatchable",
    );
  }
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
  expectedManifestItemCount?: number,
): Promise<ManagedItemEffectRow | null> {
  const completeManifestPredicate = expectedManifestItemCount === undefined
    ? ""
    : "AND (SELECT COUNT(*) FROM projection_managed_item_effect complete " +
      "WHERE complete.source_revision_ref = ?1 AND complete.projection_generation = ?2 " +
      "AND complete.job_id = ?3) = ?5 ";
  return database.prepare(
    "SELECT source_revision_ref, projection_generation, job_id, item_key, desired_index, " +
    "canonical_projection_generation, canonical_item_key, project_id, project_membership_id, " +
    "membership_generation, copy_layout, metadata_generation_digest, canonical_body_ref, " +
    "canonical_body_sha256, normalized_start_byte, normalized_end_byte, " +
    "intent_id, intent_revision, attempt_id, execution_operation_id, dispatch_lease_generation, " +
    "managed_instance_id, managed_generation, provider_source, provider_key, " +
    "section_content_sha256, document_sha256, document_size_bytes, metadata_json, state, " +
    "provider_item_id, readback_receipt_json, readback_sha256 " +
    "FROM projection_managed_item_effect WHERE source_revision_ref = ?1 " +
    "AND projection_generation = ?2 AND job_id = ?3 AND item_key = ?4 " +
    completeManifestPredicate + "LIMIT 1",
  ).bind(
    context.source_revision.source_revision_ref,
    projectionGeneration,
    context.job_id,
    itemKey,
    ...(expectedManifestItemCount === undefined ? [] : [expectedManifestItemCount]),
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
  copyPlan?: ManagedProjectCopyPlan,
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
    "SELECT job_id, state, item_count, item_set_digest, canonical_projection_generation, " +
    "canonical_item_count, canonical_item_set_digest, provider_copy_count, " +
    "provider_copy_set_digest, managed_target_metadata_generation_digest " +
    "FROM projection_generation WHERE source_revision_ref = ?1 " +
    "AND projection_generation = ?2 LIMIT 1",
  ).bind(context.source_revision.source_revision_ref, projectionGeneration)
    .first<{
      readonly job_id: unknown;
      readonly state: unknown;
      readonly item_count: unknown;
      readonly item_set_digest: unknown;
      readonly canonical_projection_generation: unknown;
      readonly canonical_item_count: unknown;
      readonly canonical_item_set_digest: unknown;
      readonly provider_copy_count: unknown;
      readonly provider_copy_set_digest: unknown;
      readonly managed_target_metadata_generation_digest: unknown;
    }>();
  if (
    generation === null ||
    generation.job_id !== context.job_id ||
    generation.state !== "MATERIALIZED"
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed item intents require the exact materialized projection generation",
    );
  }
  const canonicalItemCount = assertProjectionInteger(
    generation.item_count,
    "managed materialized item count",
    1,
    profile.maximum_synchronous_items,
  );
  const canonicalItemSetDigest = assertProjectionSha256(
    generation.item_set_digest,
    "managed materialized item set digest",
  );
  const canonicalProjectionGeneration = assertProjectionIdentifier(
    generation.canonical_projection_generation,
    "managed canonical projection generation",
  );
  const storedCanonicalItemCount = assertProjectionInteger(
    generation.canonical_item_count,
    "managed canonical item count",
    1,
    1024,
  );
  const storedCanonicalItemSetDigest = assertProjectionSha256(
    generation.canonical_item_set_digest,
    "managed canonical item set digest",
  );
  const providerCopyCount = assertProjectionInteger(
    generation.provider_copy_count,
    "managed provider copy count",
    0,
    MAX_MANAGED_PROJECT_MEMBERSHIPS,
  );
  const providerCopySetDigest = assertProjectionSha256(
    generation.provider_copy_set_digest,
    "managed provider copy set digest",
  );
  const targetMetadataGenerationDigest = await managedProjectGenerationMetadataValue(
    profile.managed_generation,
  );
  if (
    storedCanonicalItemCount !== canonicalItemCount ||
    storedCanonicalItemSetDigest !== canonicalItemSetDigest ||
    generation.managed_target_metadata_generation_digest !== targetMetadataGenerationDigest
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed generation copy receipt differs from its Work and target pins");
  }
  const manifestItemCount = canonicalItemCount * (providerCopyCount === 0 ? 1 : providerCopyCount);
  if (manifestItemCount > profile.maximum_synchronous_items) {
    projectionFail("PROJECTION_INPUT_INVALID", "managed provider effect set exceeds the synchronous item bound");
  }
  if (
    providerCopyCount > 0 && copyPlan === undefined
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "project-copy intents require their complete durable map plan");
  }
  if (copyPlan !== undefined && (
    copyPlan.target.managed_instance_id !== profile.managed_instance_id ||
    copyPlan.target.managed_generation !== profile.managed_generation ||
    copyPlan.target.metadata_generation_digest !== targetMetadataGenerationDigest ||
    copyPlan.provider_copy_count !== providerCopyCount ||
    copyPlan.provider_copy_set_sha256 !== providerCopySetDigest ||
    (providerCopyCount > 0 && (
      copyPlan.provider_item_count !== manifestItemCount ||
      copyPlan.items.length !== manifestItemCount ||
      copyPlan.copies.length !== providerCopyCount
    )) ||
    (providerCopyCount === 0 && (
      copyPlan.copies.length !== 0 ||
      copyPlan.items.length !== canonicalItemCount
    ))
  )) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed project-copy plan differs from its immutable Core receipt");
  }
  if (providerCopyCount > 0 && copyPlan !== undefined) {
    const plannedItemSetDigest = await projectionDigest(copyPlan.items.map((item) => ({
      item_key: item.item_key,
      canonical_section_id: item.canonical_section_id,
      content_sha256: item.content_sha256,
      start: item.normalized_start_byte,
      end: item.normalized_end_byte,
    })));
    if (plannedItemSetDigest !== copyPlan.provider_item_set_sha256) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed project-copy item digest differs from the complete plan");
    }
  }
  const expectedItemSetDigest = providerCopyCount === 0
    ? canonicalItemSetDigest
    : copyPlan?.provider_item_set_sha256;
  let singleItemManifestDigest: string | undefined;
  if (items.length === 1) {
    const item = items[0];
    if (item === undefined) {
      projectionFail(
        "PROJECTION_INPUT_INVALID",
        "managed item refresh is missing its exact intent",
      );
    }
    if (item.desired_index >= manifestItemCount) {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "managed item refresh is outside the prepared manifest",
      );
    }
    assertManagedItemIntent(
      context,
      projectionGeneration,
      profile,
      item,
      item.desired_index,
      canonicalProjectionGeneration,
    );
    if (manifestItemCount === 1) {
      singleItemManifestDigest = await projectionDigest([{
        item_key: item.item_key,
        canonical_section_id: item.metadata.canonical_section_id,
        content_sha256: item.section_content_sha256,
        start: item.normalized_start_byte,
        end: item.normalized_end_byte,
      }]);
      if (expectedItemSetDigest !== undefined && singleItemManifestDigest !== expectedItemSetDigest) {
        projectionFail(
          "PROJECTION_AUTHORITY_CONFLICT",
          "managed item intent differs from the exact durable projection manifest item set",
        );
      }
    }
    const row = await loadEffectRow(
      database,
      context,
      projectionGeneration,
      item.item_key,
      manifestItemCount,
    );
    if (items.length !== manifestItemCount || (row !== null && row.state !== "INTENT")) {
      if (row === null) {
        projectionFail(
          "PROJECTION_SETTLEMENT_UNCERTAIN",
          "managed item refresh has no durable intent from the complete manifest",
          true,
        );
      }
      if (row.state === "INTENT") {
        projectionFail(
          "PROJECTION_AUTHORITY_CONFLICT",
          "managed item refresh requires a durable state transition after manifest preparation",
        );
      }
      const effect = decodeEffectRow(row, context, projectionGeneration, profile, operationId, item);
      await assertCallerFence(database, operationId, callerFence, readClock(clock));
      return Object.freeze([effect]);
    }
  }
  if (items.length !== manifestItemCount) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed item refresh must name one item from the prepared manifest",
    );
  }
  if (copyPlan !== undefined && copyPlan.items.length !== items.length) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed effect set differs from its complete copy-plan size");
  }
  const actualItemSetDigest = singleItemManifestDigest ?? await projectionDigest(items.map((item, index) => {
    assertManagedItemIntent(context, projectionGeneration, profile, item, index, canonicalProjectionGeneration);
    const planned = copyPlan?.items[index];
    if (copyPlan !== undefined && (
      planned === undefined ||
      planned.item_key !== item.item_key ||
      planned.canonical_projection_generation !== item.canonical_projection_generation ||
      planned.canonical_item_key !== item.canonical_item_key ||
      planned.project_id !== item.project_id ||
      planned.project_membership_id !== item.project_membership_id ||
      planned.membership_generation !== item.membership_generation ||
      planned.provider_key !== item.provider_key ||
      planned.metadata_generation_digest !== item.metadata_generation_digest ||
      planned.canonical_body_ref !== item.canonical_body_ref ||
      planned.canonical_body_sha256 !== item.canonical_body_sha256 ||
      planned.content_sha256 !== item.section_content_sha256 ||
      planned.normalized_offset_map_ref !== `normalized-bytes:${item.normalized_start_byte}:${item.normalized_end_byte}`
    )) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed effect intent differs from its copy-plan mapping");
    }
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
      "source_revision_ref, projection_generation, job_id, item_key, " +
      "canonical_projection_generation, canonical_item_key, project_id, project_membership_id, " +
      "membership_generation, copy_layout, metadata_generation_digest, canonical_body_ref, " +
      "canonical_body_sha256, desired_index, normalized_start_byte, normalized_end_byte, " +
      "intent_id, intent_revision, attempt_id, execution_operation_id, " +
      "dispatch_lease_generation, managed_instance_id, managed_generation, provider_source, " +
      "provider_key, section_content_sha256, document_sha256, document_size_bytes, metadata_json, " +
      "state, provider_item_id, readback_receipt_json, readback_sha256, created_at, updated_at) " +
      "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20, " +
      "NULL,?21,?22,?23,?24,?25,?26,?27,?28,'INTENT',NULL,NULL,NULL,?29,?29 " +
      "WHERE EXISTS (SELECT 1 FROM operation_execution_lease l " +
      "WHERE l.operation_id = ?30 AND l.operation_kind = 'PROJECTION_EXECUTE' " +
      "AND l.lease_owner = ?31 AND l.lease_generation = ?32 AND l.state = 'LEASED' " +
      "AND l.lease_until > ?33 AND l.lease_until > " + D1_EXECUTION_LEASE_NOW_SQL +
      ") ON CONFLICT(source_revision_ref,projection_generation,item_key) " +
      "DO NOTHING",
    ).bind(
      context.source_revision.source_revision_ref,
      projectionGeneration,
      context.job_id,
      item.item_key,
      item.copy_layout === "PROJECT_COPY_V1" ? item.canonical_projection_generation : null,
      item.canonical_item_key,
      item.project_id,
      item.project_membership_id,
      item.membership_generation,
      item.copy_layout,
      item.metadata_generation_digest,
      item.canonical_body_ref,
      item.canonical_body_sha256,
      item.desired_index,
      item.normalized_start_byte,
      item.normalized_end_byte,
      context.intent_ref.id,
      context.intent_ref.revision,
      context.acceptance_attempt_id,
      operationId,
      item.managed_instance_id,
      item.managed_generation,
      item.provider_source,
      item.provider_key,
      item.section_content_sha256,
      item.document_sha256,
      item.document_size_bytes,
      canonicalProjectionJson(item.metadata),
      now,
      operationId,
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
    "AND l.lease_until > ?8 AND l.lease_until > " + D1_EXECUTION_LEASE_NOW_SQL + ") " +
    `AND ${dispatchAuthorityPredicate(10)}`,
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
    ...dispatchAuthorityBindings(context, projectionGeneration),
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
    await assertCurrentManagedDispatchAuthority(database, context, projectionGeneration);
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
