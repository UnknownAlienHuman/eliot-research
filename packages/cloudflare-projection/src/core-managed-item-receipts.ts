import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  assertProjectionSha256,
  canonicalProjectionJson,
  projectionExecutionOperationId,
  projectionDigest,
  projectionFail,
  stableProjectionId,
} from "./canonical.js";
import type {
  ProjectionAuthorityPort,
  ProjectionManagedItemGenerationProof,
  ProjectionManagedItemGenerationTarget,
  ProjectionSourceContext,
} from "./types.js";

export const MANAGED_ITEM_PROTOCOL_VERSION = "eliotr.managed-item-effects.v1";

type ManagedItemEffect = Awaited<
  ReturnType<NonNullable<ProjectionAuthorityPort["prepareManagedItems"]>>
>[number];
export type ManagedItemReceipt = NonNullable<ManagedItemEffect["receipt"]>;

interface ManagedItemGenerationRow {
  readonly source_owner_generation: unknown;
  readonly content_sha256: unknown;
  readonly object_residency_key_digest: unknown;
  readonly job_id: unknown;
  readonly state: unknown;
  readonly item_count: unknown;
  readonly item_set_digest: unknown;
  readonly managed_item_protocol: unknown;
  readonly managed_target_instance_id: unknown;
  readonly managed_target_generation: unknown;
  readonly semantic_instance_id: unknown;
  readonly semantic_generation: unknown;
  readonly semantic_receipt_ref: unknown;
  readonly semantic_readback_digest: unknown;
}

interface ManagedItemJobRow {
  readonly state: unknown;
  readonly terminal_receipt_ref: unknown;
}

interface ManagedItemExecutionRow {
  readonly execution_operation_id: unknown;
  readonly dispatch_lease_generation: unknown;
  readonly managed_instance_id: unknown;
  readonly managed_generation: unknown;
  readonly state: unknown;
}

interface ManagedItemLeaseRow {
  readonly operation_kind: unknown;
  readonly lease_generation: unknown;
  readonly state: unknown;
  readonly terminal_receipt_ref: unknown;
}

const MANAGED_RECEIPT_FIELDS = [
  "chunks_count",
  "content_sha256",
  "file_size",
  "item_key",
  "provider_item_id",
  "provider_key",
  "readback_sha256",
] as const;

export function parseManagedItemReceipt(
  value: unknown,
  label: string,
): ManagedItemReceipt | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", `${label} is not JSON text`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", `${label} is malformed`, false, cause);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", `${label} is not an object`);
  }
  const receipt = parsed as Record<string, unknown>;
  const receiptKeys = Object.keys(receipt).sort();
  if (
    receiptKeys.length !== MANAGED_RECEIPT_FIELDS.length ||
    receiptKeys.some((key, index) => key !== MANAGED_RECEIPT_FIELDS[index])
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", `${label} fields are not exact`);
  }
  return {
    item_key: assertProjectionIdentifier(receipt.item_key, `${label}.item_key`),
    provider_item_id: assertProjectionIdentifier(
      receipt.provider_item_id,
      `${label}.provider_item_id`,
    ),
    provider_key: assertProjectionIdentifier(receipt.provider_key, `${label}.provider_key`),
    file_size: assertProjectionInteger(receipt.file_size, `${label}.file_size`, 1, 4 * 1024 * 1024),
    chunks_count: assertProjectionInteger(
      receipt.chunks_count,
      `${label}.chunks_count`,
      1,
      1_000_000,
    ),
    content_sha256: assertProjectionSha256(receipt.content_sha256, `${label}.content_sha256`),
    readback_sha256: assertProjectionSha256(receipt.readback_sha256, `${label}.readback_sha256`),
  };
}

export async function readManagedItemReceipts(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  expectedCount: number,
  expectedItemSetDigest: string,
  expectedDigest: string | null,
): Promise<readonly ManagedItemReceipt[]> {
  assertProjectionInteger(expectedCount, "managed expected item count", 1, 1024);
  assertProjectionSha256(expectedItemSetDigest, "managed expected item-set digest");
  if (expectedDigest !== null) {
    assertProjectionSha256(expectedDigest, "managed expected item digest");
  }
  const rows = await database.prepare(
    "SELECT item_key, desired_index, normalized_start_byte, normalized_end_byte, " +
    "metadata_json, section_content_sha256, managed_generation, state, provider_item_id, " +
    "provider_key, document_sha256, document_size_bytes, readback_receipt_json, readback_sha256 " +
    "FROM projection_managed_item_effect WHERE source_revision_ref = ?1 " +
    "AND projection_generation = ?2 AND job_id = ?3 ORDER BY desired_index ASC",
  ).bind(
    context.source_revision.source_revision_ref,
    projectionGeneration,
    context.job_id,
  ).all<{
    readonly item_key: unknown;
    readonly desired_index: unknown;
    readonly normalized_start_byte: unknown;
    readonly normalized_end_byte: unknown;
    readonly metadata_json: unknown;
    readonly section_content_sha256: unknown;
    readonly managed_generation: unknown;
    readonly state: unknown;
    readonly provider_item_id: unknown;
    readonly provider_key: unknown;
    readonly document_sha256: unknown;
    readonly document_size_bytes: unknown;
    readonly readback_receipt_json: unknown;
    readonly readback_sha256: unknown;
  }>();
  if (!Array.isArray(rows.results) || rows.results.length !== expectedCount) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed item receipt set does not equal the durable generation item count",
    );
  }
  const requiredSet: {
    readonly item_key: string;
    readonly canonical_section_id: string;
    readonly content_sha256: string;
    readonly start: number;
    readonly end: number;
  }[] = [];
  for (const [index, row] of rows.results.entries()) {
    if (row.desired_index !== index || typeof row.metadata_json !== "string") {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "managed item intent order or metadata is incomplete",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.metadata_json);
    } catch (cause) {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "managed item intent metadata is malformed",
        false,
        cause,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item intent metadata is not an object");
    }
    const metadata = parsed as Record<string, unknown>;
    const metadataKeys = Object.keys(metadata).sort();
    if (
      metadataKeys.length !== MANAGED_METADATA_FIELDS.length ||
      metadataKeys.some((key, fieldIndex) => key !== MANAGED_METADATA_FIELDS[fieldIndex]) ||
      typeof metadata.canonical_section_id !== "string" ||
      typeof metadata.content_sha256 !== "string" ||
      metadata.instruction_taint !== context.instruction_taint ||
      metadata.projection_generation !== row.managed_generation ||
      metadata.source_revision_ref !== context.source_revision.source_revision_ref ||
      metadata.content_sha256 !== row.section_content_sha256
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item intent metadata differs from authority");
    }
    const start = assertProjectionInteger(
      row.normalized_start_byte,
      "managed item normalized start byte",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const end = assertProjectionInteger(
      row.normalized_end_byte,
      "managed item normalized end byte",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (end <= start || row.provider_key !== `${String(row.item_key)}.md`) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item span or provider key is invalid");
    }
    requiredSet.push({
      item_key: assertProjectionIdentifier(row.item_key, "managed item key"),
      canonical_section_id: assertProjectionIdentifier(
        metadata.canonical_section_id,
        "managed canonical section ID",
      ),
      content_sha256: assertProjectionSha256(row.section_content_sha256, "managed section digest"),
      start,
      end,
    });
  }
  if (await projectionDigest(requiredSet) !== expectedItemSetDigest) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed item receipts do not match the exact durable required set",
    );
  }
  const receipts: ManagedItemReceipt[] = [];
  for (const row of rows.results) {
    const receipt = parseManagedItemReceipt(row.readback_receipt_json, "managed item receipt");
    if (
      row.state !== "READBACK_VERIFIED" ||
      receipt === null ||
      receipt.item_key !== row.item_key ||
      receipt.provider_item_id !== row.provider_item_id ||
      receipt.provider_key !== row.provider_key ||
      receipt.content_sha256 !== row.document_sha256 ||
      receipt.file_size !== row.document_size_bytes ||
      receipt.readback_sha256 !== row.readback_sha256 ||
      row.readback_receipt_json !== canonicalProjectionJson(receipt)
    ) {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "managed item receipt set is incomplete or inconsistent",
      );
    }
    receipts.push(receipt);
  }
  if (expectedDigest !== null && await projectionDigest(receipts) !== expectedDigest) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed aggregate readback digest differs from durable per-item receipts",
    );
  }
  return Object.freeze(receipts);
}

export async function readManagedItemGenerationProof(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  target: ProjectionManagedItemGenerationTarget,
): Promise<ProjectionManagedItemGenerationProof> {
  const managedInstanceId = assertProjectionIdentifier(
    target.managed_instance_id,
    "managed generation target instance",
  );
  const managedGeneration = assertProjectionIdentifier(
    target.managed_generation,
    "managed generation target generation",
  );
  const generation = await database.prepare(
    "SELECT source_owner_generation, content_sha256, object_residency_key_digest, " +
    "job_id, state, item_count, item_set_digest, managed_item_protocol, " +
    "managed_target_instance_id, managed_target_generation, semantic_instance_id, " +
    "semantic_generation, semantic_receipt_ref, semantic_readback_digest " +
    "FROM projection_generation WHERE source_revision_ref = ?1 " +
    "AND projection_generation = ?2 LIMIT 1",
  ).bind(context.source_revision.source_revision_ref, projectionGeneration)
    .first<ManagedItemGenerationRow>();
  if (
    generation === null ||
    generation.job_id !== context.job_id ||
    generation.source_owner_generation !== context.source_revision.source_owner_generation ||
    generation.content_sha256 !== context.source_revision.content_sha256 ||
    generation.object_residency_key_digest !== context.source_revision.object_residency_key_digest ||
    (generation.state !== "COMPLETED" && generation.state !== "PARTIAL") ||
    generation.managed_item_protocol !== MANAGED_ITEM_PROTOCOL_VERSION ||
    generation.managed_target_instance_id !== managedInstanceId ||
    generation.managed_target_generation !== managedGeneration ||
    generation.semantic_instance_id !== managedInstanceId ||
    generation.semantic_generation !== managedGeneration
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed item proof is not bound to the exact terminal source and target generation",
    );
  }
  const itemCount = assertProjectionInteger(
    generation.item_count,
    "managed proof item count",
    1,
    1024,
  );
  const itemSetDigest = assertProjectionSha256(
    generation.item_set_digest,
    "managed proof item-set digest",
  );
  const persistedReadbackDigest = generation.semantic_readback_digest === null
    ? null
    : assertProjectionSha256(
      generation.semantic_readback_digest,
      "managed proof readback digest",
    );
  const persistedReceiptRef = generation.semantic_receipt_ref === null
    ? null
    : assertProjectionIdentifier(generation.semantic_receipt_ref, "managed proof receipt reference");
  if ((persistedReadbackDigest === null) !== (persistedReceiptRef === null)) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed proof has only one half of its persisted readback receipt",
    );
  }
  if (generation.state === "COMPLETED" && persistedReadbackDigest === null) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "completed managed item proof is missing its persisted receipt digest",
    );
  }
  const terminalJob = await database.prepare(
    "SELECT state, terminal_receipt_ref FROM job WHERE job_id = ?1 LIMIT 1",
  ).bind(context.job_id).first<ManagedItemJobRow>();
  if (
    terminalJob === null ||
    terminalJob.state !== generation.state ||
    typeof terminalJob.terminal_receipt_ref !== "string"
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed item proof requires the exact terminal projection job",
    );
  }
  const terminalReceiptRef = assertProjectionIdentifier(
    terminalJob.terminal_receipt_ref,
    "managed projection terminal receipt reference",
  );

  const operationId = await projectionExecutionOperationId(context, projectionGeneration);
  const effectRows = await database.prepare(
    "SELECT execution_operation_id, dispatch_lease_generation, managed_instance_id, " +
    "managed_generation, state " +
    "FROM projection_managed_item_effect WHERE source_revision_ref = ?1 " +
    "AND projection_generation = ?2 AND job_id = ?3 ORDER BY desired_index ASC",
  ).bind(
    context.source_revision.source_revision_ref,
    projectionGeneration,
    context.job_id,
  ).all<ManagedItemExecutionRow>();
  const effects = effectRows.results;
  if (!Array.isArray(effects) || effects.length !== itemCount) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed item proof does not contain the exact durable writer set",
    );
  }
  const dispatchLeaseGenerations = effects.map((effect) => {
    if (
      effect.execution_operation_id !== operationId ||
      effect.managed_instance_id !== managedInstanceId ||
      effect.managed_generation !== managedGeneration ||
      effect.state !== "READBACK_VERIFIED"
    ) {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "managed item proof contains a missing, unsettled, or foreign writer",
      );
    }
    return assertProjectionInteger(
      effect.dispatch_lease_generation,
      "managed item dispatch lease generation",
      1,
      Number.MAX_SAFE_INTEGER,
    );
  });

  const lease = await database.prepare(
    "SELECT operation_kind, lease_generation, state, terminal_receipt_ref " +
    "FROM operation_execution_lease WHERE operation_id = ?1 LIMIT 1",
  ).bind(operationId).first<ManagedItemLeaseRow>();
  if (
    lease === null ||
    lease.operation_kind !== "PROJECTION_EXECUTE" ||
    lease.state !== "COMPLETED" ||
    lease.terminal_receipt_ref !== terminalReceiptRef
  ) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "managed item writers have not drained under the terminal execution lease",
      true,
    );
  }
  const leaseGeneration = assertProjectionInteger(
    lease.lease_generation,
    "managed terminal lease generation",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (dispatchLeaseGenerations.some((dispatchGeneration) => dispatchGeneration > leaseGeneration)) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed item dispatch is newer than its terminal execution lease",
    );
  }
  const receipts = await readManagedItemReceipts(
    database,
    context,
    projectionGeneration,
    itemCount,
    itemSetDigest,
    persistedReadbackDigest,
  );
  const computedReadbackDigest = await projectionDigest(receipts);
  if (persistedReadbackDigest !== null && persistedReadbackDigest !== computedReadbackDigest) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed proof readback digest differs from the persisted terminal receipt",
    );
  }
  const computedManagedReceiptRef = await stableProjectionId(
    "managed-search-receipt",
    context.source_revision.source_revision_ref,
    projectionGeneration,
    managedGeneration,
    computedReadbackDigest,
  );
  if (persistedReceiptRef !== null && persistedReceiptRef !== computedManagedReceiptRef) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed proof receipt reference differs from its exact item readbacks",
    );
  }
  return Object.freeze({
    status: "ITEMS_READBACK_VERIFIED_WRITERS_DRAINED",
    source_revision_ref: context.source_revision.source_revision_ref,
    projection_generation: projectionGeneration,
    job_id: context.job_id,
    projection_terminal_state: generation.state,
    managed_instance_id: managedInstanceId,
    managed_generation: managedGeneration,
    managed_receipt_ref: computedManagedReceiptRef,
    item_count: itemCount,
    item_set_digest: itemSetDigest,
    readback_digest: computedReadbackDigest,
    writer_drain: Object.freeze({
      operation_id: operationId,
      lease_generation: leaseGeneration,
      state: "COMPLETED",
      terminal_receipt_ref: terminalReceiptRef,
    }),
  });
}

const MANAGED_METADATA_FIELDS = [
  "canonical_section_id",
  "content_sha256",
  "instruction_taint",
  "projection_generation",
  "source_revision_ref",
] as const;
