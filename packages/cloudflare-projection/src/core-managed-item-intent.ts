import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  assertProjectionSha256,
  canonicalProjectionJson,
  projectionFail,
} from "./canonical.js";
import { parseManagedItemReceipt } from "./core-managed-item-receipts.js";
import type { ProjectionAuthorityPort } from "./types.js";
import type {
  ProjectionExecutionProfile,
  ProjectionSourceContext,
} from "./types.js";

export type ManagedItemIntent = Parameters<
  NonNullable<ProjectionAuthorityPort["prepareManagedItems"]>
>[3][number];
export type ManagedItemEffect = Awaited<
  ReturnType<NonNullable<ProjectionAuthorityPort["prepareManagedItems"]>>
>[number];
export type ManagedItemReceipt = NonNullable<ManagedItemEffect["receipt"]>;

export interface ManagedItemEffectRow {
  readonly source_revision_ref: unknown;
  readonly projection_generation: unknown;
  readonly job_id: unknown;
  readonly item_key: unknown;
  readonly desired_index: unknown;
  readonly normalized_start_byte: unknown;
  readonly normalized_end_byte: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly attempt_id: unknown;
  readonly execution_operation_id: unknown;
  readonly dispatch_lease_generation: unknown;
  readonly managed_instance_id: unknown;
  readonly managed_generation: unknown;
  readonly provider_source: unknown;
  readonly provider_key: unknown;
  readonly section_content_sha256: unknown;
  readonly document_sha256: unknown;
  readonly document_size_bytes: unknown;
  readonly metadata_json: unknown;
  readonly state: unknown;
  readonly provider_item_id: unknown;
  readonly readback_receipt_json: unknown;
  readonly readback_sha256: unknown;
}

const CUSTOM_METADATA_FIELDS = [
  "canonical_section_id",
  "content_sha256",
  "instruction_taint",
  "projection_generation",
  "source_revision_ref",
] as const;

export function assertManagedItemIntent(
  context: ProjectionSourceContext,
  projectionGeneration: string,
  profile: ProjectionExecutionProfile,
  intent: ManagedItemIntent,
  expectedIndex: number,
): void {
  assertProjectionInteger(intent.desired_index, "managed item desired index", 0, 1023);
  assertProjectionIdentifier(intent.item_key, "managed item key");
  assertProjectionIdentifier(intent.provider_key, "managed provider key");
  assertProjectionIdentifier(intent.managed_instance_id, "managed instance ID");
  assertProjectionIdentifier(intent.managed_generation, "managed generation");
  assertProjectionSha256(intent.section_content_sha256, "managed section digest");
  assertProjectionSha256(intent.document_sha256, "managed document digest");
  assertProjectionInteger(
    intent.document_size_bytes,
    "managed document size",
    1,
    profile.maximum_item_utf8_bytes,
  );
  assertProjectionInteger(
    intent.normalized_start_byte,
    "managed item normalized start byte",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  assertProjectionInteger(
    intent.normalized_end_byte,
    "managed item normalized end byte",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const metadataKeys = Object.keys(intent.metadata).sort();
  if (
    intent.desired_index !== expectedIndex ||
    intent.provider_source !== "builtin" ||
    intent.provider_key !== `${intent.item_key}.md` ||
    intent.normalized_end_byte <= intent.normalized_start_byte ||
    intent.managed_instance_id !== profile.managed_instance_id ||
    intent.managed_generation !== profile.managed_generation ||
    intent.metadata.content_sha256 !== intent.section_content_sha256 ||
    intent.metadata.instruction_taint !== context.instruction_taint ||
    intent.metadata.projection_generation !== profile.managed_generation ||
    intent.metadata.source_revision_ref !== context.source_revision.source_revision_ref ||
    metadataKeys.length !== CUSTOM_METADATA_FIELDS.length ||
    metadataKeys.some((key, index) => key !== CUSTOM_METADATA_FIELDS[index]) ||
    typeof intent.metadata.canonical_section_id !== "string" ||
    intent.metadata.canonical_section_id.length === 0 ||
    Object.values(intent.metadata).some((value) => typeof value !== "string")
  ) {
    projectionFail(
      "PROJECTION_INPUT_INVALID",
      "managed item intent differs from the exact source, profile, or five-field metadata",
    );
  }
}

export function decodeEffectRow(
  row: ManagedItemEffectRow,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  profile: ProjectionExecutionProfile,
  operationId: string,
  intent: ManagedItemIntent,
): ManagedItemEffect {
  const receipt = parseManagedItemReceipt(row.readback_receipt_json, "managed item receipt");
  const metadataJson = canonicalProjectionJson(intent.metadata);
  if (
    row.source_revision_ref !== context.source_revision.source_revision_ref ||
    row.projection_generation !== projectionGeneration ||
    row.job_id !== context.job_id ||
    row.item_key !== intent.item_key ||
    row.desired_index !== intent.desired_index ||
    row.normalized_start_byte !== intent.normalized_start_byte ||
    row.normalized_end_byte !== intent.normalized_end_byte ||
    row.intent_id !== context.intent_ref.id ||
    row.intent_revision !== context.intent_ref.revision ||
    row.attempt_id !== context.acceptance_attempt_id ||
    row.execution_operation_id !== operationId ||
    row.managed_instance_id !== profile.managed_instance_id ||
    row.managed_generation !== profile.managed_generation ||
    row.provider_source !== intent.provider_source ||
    row.provider_key !== intent.provider_key ||
    row.section_content_sha256 !== intent.section_content_sha256 ||
    row.document_sha256 !== intent.document_sha256 ||
    row.document_size_bytes !== intent.document_size_bytes ||
    row.metadata_json !== metadataJson ||
    (row.state !== "INTENT" && row.state !== "DISPATCHED" &&
      row.state !== "UNKNOWN" && row.state !== "READBACK_VERIFIED")
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "stored managed item intent differs from the exact desired generation",
    );
  }
  const providerItemId = row.provider_item_id === null
    ? null
    : assertProjectionIdentifier(row.provider_item_id, "stored provider item ID");
  if (row.state === "READBACK_VERIFIED") {
    if (
      receipt === null ||
      row.readback_receipt_json !== canonicalProjectionJson(receipt) ||
      providerItemId === null ||
      receipt.item_key !== intent.item_key ||
      receipt.provider_key !== intent.provider_key ||
      receipt.provider_item_id !== providerItemId ||
      receipt.file_size !== intent.document_size_bytes ||
      receipt.content_sha256 !== intent.document_sha256 ||
      row.readback_sha256 !== receipt.readback_sha256
    ) {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "stored managed item readback receipt is incomplete or mismatched",
      );
    }
  } else if (receipt !== null || row.readback_sha256 !== null) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "unverified managed item intent contains a receipt",
    );
  }
  if (
    (row.state === "INTENT" && row.dispatch_lease_generation !== null) ||
    (row.state !== "INTENT" &&
      (typeof row.dispatch_lease_generation !== "number" ||
        !Number.isSafeInteger(row.dispatch_lease_generation) ||
        row.dispatch_lease_generation < 1))
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item dispatch fence is invalid");
  }
  return {
    item_key: intent.item_key,
    state: row.state,
    provider_item_id: providerItemId,
    receipt,
  };
}

export function assertLineage(
  row: ManagedItemEffectRow,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  operationId: string,
): void {
  if (
    row.source_revision_ref !== context.source_revision.source_revision_ref ||
    row.projection_generation !== projectionGeneration ||
    row.job_id !== context.job_id ||
    row.intent_id !== context.intent_ref.id ||
    row.intent_revision !== context.intent_ref.revision ||
    row.attempt_id !== context.acceptance_attempt_id ||
    row.execution_operation_id !== operationId
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item effect lineage changed");
  }
}
