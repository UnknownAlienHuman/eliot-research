import {
  SourceRevisionSchema,
  type SourceRevision,
  type VersionedRef,
} from "@eliotr/contracts";
import type { DeliveryMessage } from "@eliotr/platform-cloudflare";
import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  assertProjectionSha256,
  assertProjectionText,
  projectionFail,
} from "./canonical.js";
import type { ProjectionSourceContext } from "./types.js";

interface ContextRow {
  readonly outbox_id: unknown;
  readonly topic: unknown;
  readonly payload_ref: unknown;
  readonly payload_sha256: unknown;
  readonly idempotency_key: unknown;
  readonly attempts: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly operation_kind: unknown;
  readonly job_id: unknown;
  readonly job_state: unknown;
  readonly current_stage: unknown;
  readonly terminal_receipt_ref: unknown;
  readonly source_revision_ref: unknown;
  readonly source_id: unknown;
  readonly source_namespace_id: unknown;
  readonly source_owner_system_id: unknown;
  readonly source_owner_generation: unknown;
  readonly ownership_mode: unknown;
  readonly content_sha256: unknown;
  readonly object_residency_key_digest: unknown;
  readonly original_r2_key: unknown;
  readonly normalized_artifact_ref: unknown;
  readonly captured_at: unknown;
  readonly parser_profile_generation: unknown;
  readonly quality_state: unknown;
  readonly purge_state: unknown;
  readonly source_title: unknown;
  readonly source_class: unknown;
  readonly owner_status: unknown;
  readonly decision: unknown;
  readonly instruction_taint: unknown;
}

interface AcceptanceRow {
  readonly attempt_id: unknown;
}

interface MembershipRow {
  readonly project_id: unknown;
  readonly membership_generation: unknown;
}

const JOB_STATES = new Set([
  "ACCEPTED",
  "RUNNING",
  "PARTIAL",
  "BLOCKED",
  "CANCELLED",
  "COMPLETED",
  "FAILED",
] as const);
const TAINT_STATES = new Set([
  "CLEARED",
  "DATA_ONLY",
  "UNTRUSTED",
  "COMMAND_LIKE",
] as const);

function sourceRevision(row: ContextRow): SourceRevision {
  try {
    return SourceRevisionSchema.parse({
      source_revision_ref: row.source_revision_ref,
      source_id: row.source_id,
      source_namespace_id: row.source_namespace_id,
      source_owner_system_id: row.source_owner_system_id,
      source_owner_generation: row.source_owner_generation,
      ownership_mode: row.ownership_mode,
      content_sha256: row.content_sha256,
      object_residency_key_digest: row.object_residency_key_digest,
      ...(row.original_r2_key === null
        ? {}
        : { original_object_ref: row.original_r2_key }),
      ...(row.normalized_artifact_ref === null
        ? {}
        : { normalized_artifact_ref: row.normalized_artifact_ref }),
      captured_at: row.captured_at,
      ...(row.parser_profile_generation === null
        ? {}
        : { parser_profile_generation: row.parser_profile_generation }),
      quality_state: row.quality_state,
      purge_state: row.purge_state,
    });
  } catch (cause) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "stored SourceRevision authority is malformed",
      false,
      cause,
    );
  }
}

function validateMessage(row: ContextRow, message: DeliveryMessage): VersionedRef {
  const exact = row.outbox_id === message.outbox_id &&
    row.topic === message.topic &&
    row.payload_ref === message.payload_ref &&
    row.payload_sha256 === message.payload_sha256 &&
    row.idempotency_key === message.idempotency_key &&
    row.operation_kind === "PROJECTION" &&
    message.topic === "source.revision.admitted" &&
    row.source_revision_ref === message.payload_ref &&
    row.content_sha256 === message.payload_sha256;
  if (!exact) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "projection Queue message differs from durable outbox/source authority",
    );
  }
  const attempts = assertProjectionInteger(row.attempts, "outbox attempts", 0, 1_000_000);
  if (attempts < message.outbox_attempt) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "projection Queue attempt is ahead of durable outbox authority",
    );
  }
  return {
    id: assertProjectionIdentifier(row.intent_id, "intent ID"),
    revision: assertProjectionInteger(
      row.intent_revision,
      "intent revision",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

async function acceptanceAttempt(
  database: D1Database,
  intent: VersionedRef,
  jobId: string,
): Promise<string> {
  const row = await database.prepare(
    "SELECT r.attempt_id FROM operation_receipt r " +
    "WHERE r.intent_id = ?1 AND r.intent_revision = ?2 AND r.outcome = 'ACCEPTED' " +
    "AND EXISTS (SELECT 1 FROM json_each(r.output_refs_json) WHERE value = ?3) " +
    "ORDER BY r.created_at ASC, r.revision ASC LIMIT 1",
  ).bind(intent.id, intent.revision, jobId).first<AcceptanceRow>();
  if (row === null) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "durable projection job has no acceptance receipt",
      true,
    );
  }
  return assertProjectionIdentifier(row.attempt_id, "acceptance attempt ID");
}

async function membershipIds(
  database: D1Database,
  sourceId: string,
): Promise<readonly string[]> {
  const result = await database.prepare(
    "SELECT project_id, membership_generation FROM project_source_membership " +
    "WHERE source_id = ?1 AND valid_to IS NULL " +
    "ORDER BY project_id, membership_generation",
  ).bind(sourceId).all<MembershipRow>();
  if (result.success === false) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "active project membership readback failed",
      true,
    );
  }
  return (result.results ?? []).map((row) => {
    const projectId = assertProjectionIdentifier(row.project_id, "membership project_id");
    const generation = assertProjectionInteger(
      row.membership_generation,
      "membership_generation",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    return assertProjectionIdentifier(
      `project:${projectId}:generation:${generation}`,
      "project membership ID",
    );
  });
}

export async function loadProjectionSourceContext(
  database: D1Database,
  message: DeliveryMessage,
): Promise<ProjectionSourceContext> {
  const row = await database.prepare(
    "SELECT o.outbox_id, o.topic, o.payload_ref, o.payload_sha256, o.attempts, " +
    "i.idempotency_key, i.intent_id, i.revision AS intent_revision, i.operation_kind, " +
    "j.job_id, j.state AS job_state, j.current_stage, j.terminal_receipt_ref, " +
    "sr.source_revision_ref, sr.source_id, sr.source_owner_generation, sr.content_sha256, " +
    "sr.object_residency_key_digest, sr.original_r2_key, sr.normalized_artifact_ref, " +
    "sr.captured_at, sr.parser_profile_generation, sr.quality_state, sr.purge_state, " +
    "s.source_namespace_id, s.source_owner_system_id, s.ownership_mode, " +
    "s.title AS source_title, s.source_class, own.status AS owner_status, " +
    "decision.decision, decision.instruction_taint " +
    "FROM outbox o JOIN operation_intent i " +
    "ON i.intent_id = o.intent_id AND i.revision = o.intent_revision " +
    "JOIN job j ON j.intent_id = i.intent_id AND j.intent_revision = i.revision " +
    "JOIN source_revision sr ON sr.source_revision_ref = i.payload_ref " +
    "JOIN source s ON s.source_id = sr.source_id " +
    "JOIN source_namespace_ownership own " +
    "ON own.source_namespace_id = s.source_namespace_id " +
    "AND own.owner_system_id = s.source_owner_system_id " +
    "AND own.source_owner_generation = sr.source_owner_generation " +
    "JOIN source_admission_decision decision " +
    "ON decision.decision_receipt_ref = i.policy_decision_ref " +
    "AND decision.source_revision_ref = sr.source_revision_ref " +
    "AND decision.source_owner_generation = sr.source_owner_generation " +
    "WHERE o.outbox_id = ?1 " +
    "AND (SELECT COUNT(*) FROM job sibling WHERE sibling.intent_id = i.intent_id " +
    "AND sibling.intent_revision = i.revision) = 1 LIMIT 1",
  ).bind(message.outbox_id).first<ContextRow>();
  if (row === null) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "projection execution authority is missing",
      true,
    );
  }
  const intent = validateMessage(row, message);
  if (
    row.owner_status !== "ACTIVE" ||
    row.decision !== "ADMITTED" ||
    row.purge_state !== "LIVE"
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "projection source is not admitted, live, and owned by the active generation",
    );
  }
  if (typeof row.job_state !== "string" || !JOB_STATES.has(row.job_state as never)) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "stored projection job state is invalid");
  }
  if (typeof row.instruction_taint !== "string" || !TAINT_STATES.has(row.instruction_taint as never)) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "stored instruction taint is invalid");
  }
  const revision = sourceRevision(row);
  assertProjectionSha256(revision.content_sha256, "SourceRevision content_sha256");
  if (revision.normalized_artifact_ref === undefined) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "projection SourceRevision has no normalized artifact authority",
    );
  }
  const jobId = assertProjectionIdentifier(row.job_id, "projection job ID");
  return {
    message,
    intent_ref: intent,
    job_id: jobId,
    job_state: row.job_state as ProjectionSourceContext["job_state"],
    acceptance_attempt_id: await acceptanceAttempt(database, intent, jobId),
    source_revision: revision,
    source_title: assertProjectionText(row.source_title, "source title"),
    source_class: assertProjectionIdentifier(row.source_class, "source class"),
    instruction_taint: row.instruction_taint as ProjectionSourceContext["instruction_taint"],
    project_membership_ids: await membershipIds(database, revision.source_id),
  };
}
