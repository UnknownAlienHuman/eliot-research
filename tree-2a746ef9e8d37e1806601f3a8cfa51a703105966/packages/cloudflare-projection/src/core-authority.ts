import {
  OperationReceiptSchema,
  type OperationReceipt,
} from "@eliotr/contracts";
import type { DeliveryMessage } from "@eliotr/platform-cloudflare";
import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  projectionFail,
  projectionReceiptRef,
} from "./canonical.js";
import { loadProjectionSourceContext } from "./core-load.js";
import {
  settleProjection,
  validateProjectionWorkReceipt,
} from "./core-settlement.js";
import type {
  ProjectionAuthorityPort,
  ProjectionExecutionProfile,
  ProjectionSourceContext,
  ProjectionTerminalReceipt,
} from "./types.js";

interface GenerationRow {
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
  readonly semantic_receipt_ref: unknown;
  readonly semantic_readback_digest: unknown;
  readonly reason_codes_json: unknown;
}

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

function nowIso(clock: () => number): string {
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

async function generationRow(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
): Promise<GenerationRow | null> {
  return database.prepare(
    "SELECT job_id, source_owner_generation, content_sha256, object_residency_key_digest, " +
    "projector_profile, state, item_count, item_set_digest, work_manifest_ref, " +
    "work_manifest_sha256, d1_search_receipt_ref, d1_search_readback_digest, " +
    "semantic_instance_id, semantic_generation, semantic_receipt_ref, " +
    "semantic_readback_digest, reason_codes_json FROM projection_generation " +
    "WHERE source_revision_ref = ?1 AND projection_generation = ?2 LIMIT 1",
  ).bind(
    context.source_revision.source_revision_ref,
    projectionGeneration,
  ).first<GenerationRow>();
}

function validateGenerationIdentity(
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
}

async function readTerminalReceipt(
  database: D1Database,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  profile: ProjectionExecutionProfile,
): Promise<ProjectionTerminalReceipt | null> {
  const generation = await generationRow(database, context, projectionGeneration);
  if (generation === null || (generation.state !== "COMPLETED" && generation.state !== "PARTIAL")) {
    return null;
  }
  validateGenerationIdentity(generation, context, profile);
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
  return {
    receipt,
    receipt_ref: projectionReceiptRef(receipt.receipt_ref.id, receipt.receipt_ref.revision),
    outcome: expectedOutcome,
    projection_generation: projectionGeneration,
  };
}

export interface D1ProjectionAuthorityDependencies {
  readonly database: D1Database;
  readonly now?: () => number;
}

export function createD1ProjectionAuthority(
  dependencies: D1ProjectionAuthorityDependencies,
): ProjectionAuthorityPort {
  const database = dependencies.database;
  const clock = dependencies.now ?? Date.now;
  const authority: ProjectionAuthorityPort = {
    load(message: DeliveryMessage) {
      return loadProjectionSourceContext(database, message);
    },

    readTerminal(context, projectionGeneration, profile) {
      return readTerminalReceipt(database, context, projectionGeneration, profile);
    },

    async begin(context, projectionGeneration, profile) {
      const now = nowIso(clock);
      const existing = await generationRow(database, context, projectionGeneration);
      if (existing !== null) {
        validateGenerationIdentity(existing, context, profile);
        if (existing.state === "COMPLETED" || existing.state === "PARTIAL") return;
      } else {
        await database.prepare(
          "INSERT INTO projection_generation(" +
          "source_revision_ref, projection_generation, job_id, source_owner_generation, " +
          "content_sha256, object_residency_key_digest, projector_profile, state, " +
          "reason_codes_json, created_at, updated_at) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,'PREPARING','[]',?8,?8)",
        ).bind(
          context.source_revision.source_revision_ref,
          projectionGeneration,
          context.job_id,
          context.source_revision.source_owner_generation,
          context.source_revision.content_sha256,
          context.source_revision.object_residency_key_digest,
          profile.projector_profile,
          now,
        ).run();
      }
      await database.prepare(
        "UPDATE job SET state = 'RUNNING', current_stage = 'PROJECTION_MATERIALIZING', " +
        "updated_at = ?2 WHERE job_id = ?1 AND state IN ('ACCEPTED','RUNNING')",
      ).bind(context.job_id, now).run();
      const readback = await generationRow(database, context, projectionGeneration);
      if (readback === null) {
        projectionFail(
          "PROJECTION_SETTLEMENT_UNCERTAIN",
          "projection generation begin readback is missing",
          true,
        );
      }
      validateGenerationIdentity(readback, context, profile);
    },

    async recordMaterialized(context, projectionGeneration, receipt) {
      validateProjectionWorkReceipt(receipt);
      const now = nowIso(clock);
      await database.prepare(
        "UPDATE projection_generation SET state = 'MATERIALIZED', item_count = ?3, " +
        "item_set_digest = ?4, work_manifest_ref = ?5, work_manifest_sha256 = ?6, " +
        "updated_at = ?7 WHERE source_revision_ref = ?1 AND projection_generation = ?2 " +
        "AND state IN ('PREPARING','MATERIALIZED')",
      ).bind(
        context.source_revision.source_revision_ref,
        projectionGeneration,
        receipt.item_count,
        receipt.item_set_digest,
        receipt.manifest_ref,
        receipt.manifest_sha256,
        now,
      ).run();
      const readback = await generationRow(database, context, projectionGeneration);
      if (
        readback === null ||
        readback.state !== "MATERIALIZED" ||
        readback.item_count !== receipt.item_count ||
        readback.item_set_digest !== receipt.item_set_digest ||
        readback.work_manifest_ref !== receipt.manifest_ref ||
        readback.work_manifest_sha256 !== receipt.manifest_sha256
      ) {
        projectionFail(
          "PROJECTION_SETTLEMENT_UNCERTAIN",
          "projection materialization authority did not settle exactly",
          true,
        );
      }
    },

    settle(context, projectionGeneration, profile, settlement) {
      return settleProjection({
        database,
        context,
        projection_generation: projectionGeneration,
        profile,
        settlement,
        now: nowIso(clock),
        read_terminal: () => readTerminalReceipt(
          database,
          context,
          projectionGeneration,
          profile,
        ),
      });
    },
  };
  return authority;
}
