import {
  OperationReceiptSchema,
  type OperationReceipt,
} from "@eliotr/contracts";
import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  assertProjectionSha256,
  legacyProjectionGeneration,
  projectionGeneration as targetProjectionGeneration,
  projectionDigest,
  projectionFail,
  projectionReceiptRef,
  stableProjectionId,
} from "./canonical.js";
import {
  generationRow,
  validateGenerationIdentity,
  type GenerationRow,
} from "./core-generation-state.js";
import {
  MANAGED_ITEM_PROTOCOL_VERSION,
  readManagedItemReceipts,
} from "./core-managed-item-receipts.js";
import type {
  ProjectionExecutionProfile,
  ProjectionSourceContext,
  ProjectionTerminalReceipt,
} from "./types.js";
interface JobTerminalRow {
  readonly state: unknown;
  readonly terminal_receipt_ref: unknown;
}

interface TerminalGuardRow {
  readonly job_id: unknown;
  readonly terminal_receipt_id: unknown;
  readonly terminal_receipt_revision: unknown;
  readonly outcome: unknown;
  readonly verified: unknown;
}

interface ReceiptRow {
  readonly receipt_id: unknown;
  readonly revision: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly attempt_id: unknown;
  readonly outcome: unknown;
  readonly output_refs_json: unknown;
  readonly readback_receipt_refs_json: unknown;
  readonly reconciliation_required: unknown;
  readonly reason_codes_json: unknown;
  readonly created_at: unknown;
}

function parseStringArray(value: unknown, label: string): readonly string[] {
  if (typeof value !== "string") {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", `${label} is not JSON text`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch (cause) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", `${label} is malformed`, false, cause);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 256 ||
    parsed.some((entry) => typeof entry !== "string" || entry.length < 1 || entry.length > 1024)
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", `${label} is not a bounded string array`);
  }
  return parsed as readonly string[];
}

function parseReceiptReference(value: unknown): { readonly id: string; readonly revision: number } {
  if (typeof value !== "string" || !value.startsWith("receipt:")) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "job terminal receipt reference is invalid");
  }
  const body = value.slice("receipt:".length);
  const separator = body.lastIndexOf(":");
  if (separator < 1) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "job terminal receipt reference is incomplete");
  }
  const id = assertProjectionIdentifier(body.slice(0, separator), "terminal receipt ID");
  const revisionText = body.slice(separator + 1);
  if (!/^[1-9][0-9]*$/u.test(revisionText)) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "terminal receipt revision is invalid");
  }
  return {
    id,
    revision: assertProjectionInteger(
      Number(revisionText),
      "terminal receipt revision",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function decodeReceipt(row: ReceiptRow): OperationReceipt {
  let receipt: OperationReceipt;
  try {
    receipt = OperationReceiptSchema.parse({
      receipt_ref: { id: row.receipt_id, revision: row.revision },
      intent_ref: { id: row.intent_id, revision: row.intent_revision },
      attempt_id: row.attempt_id,
      outcome: row.outcome,
      output_refs: parseStringArray(row.output_refs_json, "receipt output refs"),
      readback_receipt_refs: parseStringArray(
        row.readback_receipt_refs_json,
        "receipt readback refs",
      ),
      reconciliation_required: row.reconciliation_required === 1,
      reason_codes: parseStringArray(row.reason_codes_json, "receipt reason codes"),
      created_at: row.created_at,
    });
  } catch (cause) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "stored projection terminal receipt is malformed",
      false,
      cause,
    );
  }
  return receipt;
}

async function verifyManagedTerminalReadback(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  profile: ProjectionExecutionProfile,
  generation: GenerationRow,
  receipt: OperationReceipt,
  expectedOutcome: "SUCCEEDED" | "PARTIAL",
): Promise<void> {
  const persistedReadbackDigest = generation.semantic_readback_digest === null
    ? null
    : assertProjectionSha256(
      generation.semantic_readback_digest,
      "managed terminal readback digest",
    );
  const persistedReceiptRef = generation.semantic_receipt_ref === null
    ? null
    : assertProjectionIdentifier(
      generation.semantic_receipt_ref,
      "managed terminal receipt reference",
    );
  if ((persistedReadbackDigest === null) !== (persistedReceiptRef === null)) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed terminal has only one half of its persisted readback receipt",
    );
  }
  if (persistedReadbackDigest === null) {
    if (expectedOutcome === "SUCCEEDED") {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "completed managed generation is missing its persisted readback receipt",
      );
    }
    const nonManagedRefs = new Set([
      context.job_id,
      `projection-generation:${projectionGeneration}`,
      ...(typeof generation.work_manifest_ref === "string"
        ? [generation.work_manifest_ref]
        : []),
      ...(typeof generation.d1_search_receipt_ref === "string"
        ? [generation.d1_search_receipt_ref]
        : []),
    ]);
    if (
      [...receipt.output_refs, ...receipt.readback_receipt_refs]
        .some((reference) => !nonManagedRefs.has(reference))
    ) {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "partial managed generation claims a receipt without persisted readback authority",
      );
    }
    return;
  }
  if (
    generation.semantic_instance_id !== profile.managed_instance_id ||
    generation.semantic_generation !== profile.managed_generation
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed terminal readback differs from its pinned semantic target",
    );
  }
  const itemCount = assertProjectionInteger(
    generation.item_count,
    "managed terminal item count",
    1,
    1024,
  );
  const itemSetDigest = assertProjectionSha256(
    generation.item_set_digest,
    "managed terminal required-set digest",
  );
  const itemReceipts = await readManagedItemReceipts(
    database,
    context,
    projectionGeneration,
    itemCount,
    itemSetDigest,
    null,
  );
  const computedReadbackDigest = await projectionDigest(itemReceipts);
  if (computedReadbackDigest !== persistedReadbackDigest) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed terminal readback differs from its persisted digest",
    );
  }
  const computedReceiptRef = await stableProjectionId(
    "managed-search-receipt",
    context.source_revision.source_revision_ref,
    projectionGeneration,
    profile.managed_generation,
    computedReadbackDigest,
  );
  if (
    persistedReceiptRef !== computedReceiptRef ||
    !receipt.output_refs.includes(computedReceiptRef) ||
    !receipt.readback_receipt_refs.includes(computedReceiptRef)
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "managed terminal receipt reference is forged or unbound",
    );
  }
}

export async function readTerminalReceipt(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  profile: ProjectionExecutionProfile,
  generationOverride?: GenerationRow,
): Promise<ProjectionTerminalReceipt | null> {
  const generation = generationOverride ??
    await generationRow(database, context, projectionGeneration);
  if (generation === null) return null;
  validateGenerationIdentity(generation, context, profile);
  if (generation.state !== "COMPLETED" && generation.state !== "PARTIAL") return null;
  if (
    generation.managed_item_protocol === MANAGED_ITEM_PROTOCOL_VERSION &&
    (generation.semantic_instance_id !== null ||
      generation.semantic_generation !== null) &&
    (generation.semantic_instance_id !== profile.managed_instance_id ||
      generation.semantic_generation !== profile.managed_generation)
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "terminal semantic receipt differs from its pinned managed target",
    );
  }
  const job = await database.prepare(
    "SELECT state, terminal_receipt_ref FROM job WHERE job_id = ?1 LIMIT 1",
  ).bind(context.job_id).first<JobTerminalRow>();
  const expectedJobState = generation.state === "COMPLETED" ? "COMPLETED" : "PARTIAL";
  if (job === null || job.state !== expectedJobState || job.terminal_receipt_ref === null) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "projection generation is terminal but job receipt authority is incomplete",
      true,
    );
  }
  const ref = parseReceiptReference(job.terminal_receipt_ref);
  const row = await database.prepare(
    "SELECT receipt_id, revision, intent_id, intent_revision, attempt_id, outcome, " +
    "output_refs_json, readback_receipt_refs_json, reconciliation_required, " +
    "reason_codes_json, created_at FROM operation_receipt " +
    "WHERE receipt_id = ?1 AND revision = ?2 LIMIT 1",
  ).bind(ref.id, ref.revision).first<ReceiptRow>();
  if (row === null) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "projection terminal receipt is missing",
      true,
    );
  }
  const receipt = decodeReceipt(row);
  const expectedOutcome = generation.state === "COMPLETED" ? "SUCCEEDED" : "PARTIAL";
  if (
    receipt.intent_ref.id !== context.intent_ref.id ||
    receipt.intent_ref.revision !== context.intent_ref.revision ||
    receipt.attempt_id !== context.acceptance_attempt_id ||
    receipt.outcome !== expectedOutcome ||
    !receipt.output_refs.includes(context.job_id) ||
    !receipt.output_refs.includes(`projection-generation:${projectionGeneration}`)
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "projection terminal receipt is not bound to the exact job generation",
    );
  }
  const guard = await database.prepare(
    "SELECT job_id, terminal_receipt_id, terminal_receipt_revision, outcome, verified " +
    "FROM projection_terminal_guard WHERE source_revision_ref = ?1 " +
    "AND projection_generation = ?2 LIMIT 1",
  ).bind(
    context.source_revision.source_revision_ref,
    projectionGeneration,
  ).first<TerminalGuardRow>();
  if (
    guard === null ||
    guard.job_id !== context.job_id ||
    guard.terminal_receipt_id !== receipt.receipt_ref.id ||
    guard.terminal_receipt_revision !== receipt.receipt_ref.revision ||
    guard.outcome !== expectedOutcome ||
    guard.verified !== 1
  ) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "projection terminal guard readback is missing or inconsistent",
      true,
    );
  }
  if (generation.managed_item_protocol === MANAGED_ITEM_PROTOCOL_VERSION) {
    await verifyManagedTerminalReadback(
      database,
      context,
      projectionGeneration,
      profile,
      generation,
      receipt,
      expectedOutcome,
    );
  }
  return {
    receipt,
    receipt_ref: projectionReceiptRef(receipt.receipt_ref.id, receipt.receipt_ref.revision),
    outcome: expectedOutcome,
    projection_generation: projectionGeneration,
  };
}

export async function readTerminalForProfile(
  database: D1Database,
  context: ProjectionSourceContext,
  requestedGeneration: string,
  profile: ProjectionExecutionProfile,
): Promise<ProjectionTerminalReceipt | null> {
  const targetGeneration = await targetProjectionGeneration(context, profile);
  if (requestedGeneration !== targetGeneration) {
    return readTerminalReceipt(
      database,
      context,
      requestedGeneration,
      profile,
    );
  }

  const exactGeneration = await generationRow(database, context, targetGeneration);
  if (exactGeneration !== null) {
    if (exactGeneration.managed_item_protocol === null) {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "target-bound projection generation is missing its managed-item protocol marker",
      );
    }
    return readTerminalReceipt(
      database,
      context,
      targetGeneration,
      profile,
      exactGeneration,
    );
  }

  const legacyGeneration = await legacyProjectionGeneration(context, profile);
  if (legacyGeneration === targetGeneration) return null;
  const historicalGeneration = await generationRow(
    database,
    context,
    legacyGeneration,
  );
  if (
    historicalGeneration === null ||
    historicalGeneration.managed_item_protocol !== null
  ) {
    return null;
  }
  if (
    historicalGeneration.state !== "COMPLETED" &&
    historicalGeneration.state !== "PARTIAL"
  ) {
    return null;
  }
  return readTerminalReceipt(
    database,
    context,
    legacyGeneration,
    profile,
    historicalGeneration,
  );
}
