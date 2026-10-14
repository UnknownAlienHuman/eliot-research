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
import { managedProjectGenerationMetadataValue, parseManagedProjectMembershipId } from "./managed-project-path.js";

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
  readonly canonical_projection_generation: unknown;
  readonly canonical_item_count: unknown;
  readonly canonical_item_set_digest: unknown;
  readonly provider_copy_count: unknown;
  readonly provider_copy_set_digest: unknown;
  readonly managed_target_metadata_generation_digest: unknown;
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
  readonly item_key: unknown;
  readonly canonical_projection_generation: unknown;
  readonly desired_index: unknown;
  readonly normalized_start_byte: unknown;
  readonly normalized_end_byte: unknown;
  readonly metadata_json: unknown;
  readonly section_content_sha256: unknown;
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
    "canonical_projection_generation, canonical_item_key, project_id, project_membership_id, " +
    "membership_generation, copy_layout, metadata_generation_digest, canonical_body_ref, " +
    "canonical_body_sha256, metadata_json, section_content_sha256, managed_generation, state, provider_item_id, " +
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
    readonly canonical_projection_generation: unknown;
    readonly canonical_item_key: unknown;
    readonly project_id: unknown;
    readonly project_membership_id: unknown;
    readonly membership_generation: unknown;
    readonly copy_layout: unknown;
    readonly metadata_generation_digest: unknown;
    readonly canonical_body_ref: unknown;
    readonly canonical_body_sha256: unknown;
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
      metadata.projection_generation !== (
        row.copy_layout === "PROJECT_COPY_V1"
          ? row.metadata_generation_digest
          : row.managed_generation
      ) ||
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
    const flatLayout = row.copy_layout === null;
    let copyIdentityValid = false;
    if (flatLayout) {
      copyIdentityValid =
        row.canonical_projection_generation === null &&
        row.canonical_item_key === null &&
        row.project_id === null &&
        row.project_membership_id === null &&
        row.membership_generation === null &&
        row.metadata_generation_digest === null &&
        row.canonical_body_ref === null &&
        row.canonical_body_sha256 === null &&
        row.provider_key === `${String(row.item_key)}.md`;
    } else if (row.copy_layout === "PROJECT_COPY_V1") {
      const membershipId = assertProjectionIdentifier(row.project_membership_id, "managed membership ID");
      const membership = parseManagedProjectMembershipId(membershipId);
      const projectId = assertProjectionIdentifier(row.project_id, "managed project ID");
      const membershipGeneration = assertProjectionInteger(
        row.membership_generation,
        "managed membership generation",
        1,
        Number.MAX_SAFE_INTEGER,
      );
      const targetDigest = assertProjectionSha256(
        row.metadata_generation_digest,
        "managed metadata generation digest",
      );
      const canonicalGeneration = assertProjectionIdentifier(
        row.canonical_projection_generation,
        "managed canonical projection generation",
      );
      const canonicalItemKey = assertProjectionIdentifier(row.canonical_item_key, "managed canonical item key");
      const bodyRef = assertProjectionIdentifier(row.canonical_body_ref, "managed canonical body ref");
      const bodyDigest = assertProjectionSha256(row.canonical_body_sha256, "managed canonical body digest");
      const providerKey = assertProjectionIdentifier(row.provider_key, "managed provider key");
      const managedGeneration = assertProjectionIdentifier(row.managed_generation, "managed raw generation");
      copyIdentityValid =
        membership.project_id === projectId &&
        membership.membership_generation === membershipGeneration &&
        canonicalGeneration.length > 0 &&
        canonicalItemKey.length > 0 &&
        bodyRef.length > 0 &&
        bodyDigest === row.section_content_sha256 &&
        providerKey.startsWith("projection/") &&
        providerKey.endsWith(`${String(row.item_key)}.md`) &&
        providerKey.length <= 128 &&
        targetDigest === await managedProjectGenerationMetadataValue(managedGeneration);
    }
    if (end <= start || !copyIdentityValid) {
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
    "managed_target_instance_id, managed_target_generation, " +
    "managed_target_metadata_generation_digest, canonical_projection_generation, " +
    "canonical_item_count, canonical_item_set_digest, provider_copy_count, " +
    "provider_copy_set_digest, semantic_instance_id, " +
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
    generation.managed_target_metadata_generation_digest !==
      await managedProjectGenerationMetadataValue(managedGeneration) ||
    generation.semantic_instance_id !== managedInstanceId ||
    generation.semantic_generation !== managedGeneration
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed item proof is not bound to the exact terminal source and target generation",
    );
  }
  const canonicalItemCount = assertProjectionInteger(
    generation.item_count,
    "managed proof canonical item count",
    1,
    128,
  );
  const canonicalItemSetDigest = assertProjectionSha256(
    generation.item_set_digest,
    "managed proof canonical item-set digest",
  );
  const storedCanonicalCount = assertProjectionInteger(
    generation.canonical_item_count,
    "managed proof canonical receipt count",
    1,
    1024,
  );
  const storedCanonicalDigest = assertProjectionSha256(
    generation.canonical_item_set_digest,
    "managed proof canonical receipt digest",
  );
  const canonicalProjectionGeneration = assertProjectionIdentifier(
    generation.canonical_projection_generation,
    "managed proof canonical projection generation",
  );
  const providerCopyCount = assertProjectionInteger(
    generation.provider_copy_count,
    "managed proof provider copy count",
    0,
    256,
  );
  const providerCopySetDigest = assertProjectionSha256(
    generation.provider_copy_set_digest,
    "managed proof provider copy set digest",
  );
  if (storedCanonicalCount !== canonicalItemCount || storedCanonicalDigest !== canonicalItemSetDigest) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed proof canonical receipt differs from Work authority");
  }
  const itemCount = canonicalItemCount * (providerCopyCount === 0 ? 1 : providerCopyCount);
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
    "SELECT item_key, canonical_projection_generation, desired_index, normalized_start_byte, " +
    "normalized_end_byte, metadata_json, " +
    "section_content_sha256, execution_operation_id, dispatch_lease_generation, " +
    "managed_instance_id, managed_generation, state " +
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
  const effectRequiredSet = effects.map((effect, index) => {
    if (
      effect.desired_index !== index ||
      typeof effect.metadata_json !== "string" ||
      effect.canonical_projection_generation !== (
        providerCopyCount === 0 ? null : canonicalProjectionGeneration
      )
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed proof effect ordering or metadata is incomplete");
    }
    let value: unknown;
    try {
      value = JSON.parse(effect.metadata_json);
    } catch (cause) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed proof effect metadata is malformed", false, cause);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed proof effect metadata is not an object");
    }
    const metadata = value as Record<string, unknown>;
    return {
      item_key: assertProjectionIdentifier(effect.item_key, "managed proof effect item key"),
      canonical_section_id: assertProjectionIdentifier(
        metadata.canonical_section_id,
        "managed proof effect canonical section ID",
      ),
      content_sha256: assertProjectionSha256(effect.section_content_sha256, "managed proof effect content digest"),
      start: assertProjectionInteger(effect.normalized_start_byte, "managed proof effect start", 0, Number.MAX_SAFE_INTEGER),
      end: assertProjectionInteger(effect.normalized_end_byte, "managed proof effect end", 1, Number.MAX_SAFE_INTEGER),
    };
  });
  const itemSetDigest = await projectionDigest(effectRequiredSet);
  if (providerCopyCount === 0 && itemSetDigest !== canonicalItemSetDigest) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "flat managed effect set differs from canonical Work receipt");
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
    canonical_item_count: canonicalItemCount,
    canonical_item_set_digest: canonicalItemSetDigest,
    provider_copy_count: providerCopyCount,
    provider_copy_set_digest: providerCopySetDigest,
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
