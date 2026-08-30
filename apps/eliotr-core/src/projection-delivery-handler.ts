import {
  OperationIntentSchema,
  type OperationAttempt,
  type OperationIntent,
  type OperationReceipt,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  DeliveryRuntimeError,
  createD1ExecutionLeaseStore,
  type DeliveryHandler,
  type DeliveryMessage,
  type ExecutionFence,
} from "@eliotr/platform-cloudflare";

interface AuthorityRow {
  readonly outbox_id: unknown;
  readonly topic: unknown;
  readonly payload_ref: unknown;
  readonly payload_sha256: unknown;
  readonly attempts: unknown;
  readonly intent_id: unknown;
  readonly revision: unknown;
  readonly operation_kind: unknown;
  readonly principal_ref: unknown;
  readonly idempotency_key: unknown;
  readonly policy_decision_ref: unknown;
  readonly budget_reservation_ref: unknown;
  readonly cancellation_ref: unknown;
  readonly created_at: unknown;
}
interface SourceRow {
  readonly source_revision_ref: unknown;
  readonly content_sha256: unknown;
}
interface ReceiptRow {
  readonly receipt_id: unknown;
  readonly revision: unknown;
  readonly outcome: unknown;
}
interface JobRow {
  readonly job_id: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly state: unknown;
  readonly current_stage: unknown;
  readonly terminal_receipt_ref: unknown;
}
interface AttemptRow {
  readonly attempt_id: unknown;
  readonly state: unknown;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const PROJECTION_TOPIC = "source.revision.admitted";
const EXECUTION_LEASE_MS = 60_000;

function retryable(
  code: "DELIVERY_SETTLEMENT_UNCERTAIN" | "DELIVERY_LEASE_LOST",
  message: string,
  cause?: unknown,
): never {
  throw new DeliveryRuntimeError(code, message, true, cause);
}

function receiptString(ref: VersionedRef): string {
  return `receipt:${ref.id}:${ref.revision}`;
}

async function stableId(prefix: string, identity: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${prefix}\u0000${identity}`));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex.slice(0, 48)}`;
}

function decodeIntent(row: AuthorityRow): OperationIntent {
  return OperationIntentSchema.parse({
    intent_ref: { id: row.intent_id, revision: row.revision },
    operation_kind: row.operation_kind,
    principal_ref: row.principal_ref,
    idempotency_key: row.idempotency_key,
    payload_ref: row.payload_ref,
    policy_decision_ref: row.policy_decision_ref,
    ...(row.budget_reservation_ref === null ? {} : { budget_reservation_ref: row.budget_reservation_ref }),
    ...(row.cancellation_ref === null ? {} : { cancellation_ref: row.cancellation_ref }),
    created_at: row.created_at,
  });
}

async function loadAuthority(database: D1Database, message: DeliveryMessage): Promise<OperationIntent> {
  const row = await database.prepare(
    "SELECT o.outbox_id, o.topic, o.payload_ref, o.payload_sha256, o.attempts, " +
    "i.intent_id, i.revision, i.operation_kind, i.principal_ref, i.idempotency_key, " +
    "i.policy_decision_ref, i.budget_reservation_ref, i.cancellation_ref, i.created_at " +
    "FROM outbox o JOIN operation_intent i ON i.intent_id = o.intent_id AND i.revision = o.intent_revision " +
    "WHERE o.outbox_id = ?1 LIMIT 1",
  ).bind(message.outbox_id).first<AuthorityRow>();
  if (row === null) retryable("DELIVERY_SETTLEMENT_UNCERTAIN", "Queue message has no durable outbox authority");
  const intent = decodeIntent(row);
  const exact = row.outbox_id === message.outbox_id &&
    row.topic === message.topic &&
    row.payload_ref === message.payload_ref &&
    row.payload_sha256 === message.payload_sha256 &&
    row.idempotency_key === message.idempotency_key &&
    typeof row.attempts === "number" &&
    Number.isSafeInteger(row.attempts) &&
    row.attempts >= message.outbox_attempt;
  if (!exact) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "Queue message does not match durable outbox authority");
  }
  if (intent.operation_kind !== "PROJECTION" || message.topic !== PROJECTION_TOPIC) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "Queue topic and operation kind are not a supported projection handoff");
  }
  return intent;
}

async function requireActiveRevision(
  database: D1Database,
  sourceRevisionRef: string,
  payloadSha256: string,
): Promise<void> {
  const row = await database.prepare(
    "SELECT sr.source_revision_ref, sr.content_sha256 FROM source_revision sr " +
    "JOIN source s ON s.source_id = sr.source_id " +
    "JOIN source_namespace_ownership o ON o.source_namespace_id = s.source_namespace_id " +
    "AND o.source_owner_generation = sr.source_owner_generation AND o.status = 'ACTIVE' " +
    "WHERE sr.source_revision_ref = ?1 AND sr.purge_state = 'LIVE' LIMIT 1",
  ).bind(sourceRevisionRef).first<SourceRow>();
  if (row === null) {
    throw new DeliveryRuntimeError(
      "DELIVERY_INPUT_INVALID",
      "projection handoff references a missing, purged, quarantined, or fenced source revision",
    );
  }
  if (row.source_revision_ref !== sourceRevisionRef || row.content_sha256 !== payloadSha256 || !SHA256.test(payloadSha256)) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "projection payload digest does not match the admitted source revision");
  }
}

async function findAcknowledgingReceipt(database: D1Database, intentRef: VersionedRef): Promise<VersionedRef | null> {
  const row = await database.prepare(
    "SELECT receipt_id, revision, outcome FROM operation_receipt WHERE intent_id = ?1 AND intent_revision = ?2 " +
    "ORDER BY created_at DESC, revision DESC LIMIT 1",
  ).bind(intentRef.id, intentRef.revision).first<ReceiptRow>();
  if (row === null) return null;
  if (typeof row.receipt_id !== "string" || !IDENTIFIER.test(row.receipt_id) ||
      typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
      typeof row.outcome !== "string") {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "operation receipt authority is malformed");
  }
  return { id: row.receipt_id, revision: row.revision };
}

async function verifyAcceptedState(
  database: D1Database,
  intent: OperationIntent,
  jobId: string,
  attemptId: string,
  receipt: OperationReceipt,
): Promise<void> {
  const [job, attempt, storedReceipt] = await Promise.all([
    database.prepare(
      "SELECT job_id, intent_id, intent_revision, state, current_stage, terminal_receipt_ref FROM job WHERE job_id = ?1 LIMIT 1",
    ).bind(jobId).first<JobRow>(),
    database.prepare("SELECT attempt_id, state FROM operation_attempt WHERE attempt_id = ?1 LIMIT 1")
      .bind(attemptId).first<AttemptRow>(),
    database.prepare(
      "SELECT receipt_id, revision, outcome FROM operation_receipt WHERE receipt_id = ?1 AND revision = ?2 LIMIT 1",
    ).bind(receipt.receipt_ref.id, receipt.receipt_ref.revision).first<ReceiptRow>(),
  ]);
  const validJob = job !== null && job.job_id === jobId && job.intent_id === intent.intent_ref.id &&
    job.intent_revision === intent.intent_ref.revision && job.state === "ACCEPTED" &&
    job.current_stage === "PROJECTION_QUEUED" && job.terminal_receipt_ref === null;
  const validAttempt = attempt !== null && attempt.attempt_id === attemptId && attempt.state === "CHECKPOINTED";
  const validReceipt = storedReceipt !== null && storedReceipt.receipt_id === receipt.receipt_ref.id &&
    storedReceipt.revision === receipt.receipt_ref.revision && storedReceipt.outcome === "ACCEPTED";
  if (!validJob || !validAttempt || !validReceipt) retryable("DELIVERY_SETTLEMENT_UNCERTAIN", "projection acceptance readback is incomplete");
}

async function failLeaseQuietly(
  store: ReturnType<typeof createD1ExecutionLeaseStore>,
  fence: ExecutionFence,
  nowMs: number,
): Promise<void> {
  try { await store.fail(fence, "PROJECTION_ACCEPTANCE_FAILED", nowMs); } catch { /* retain original failure */ }
}

export function createProjectionDeliveryHandler(
  database: D1Database,
  clock: () => number = Date.now,
): DeliveryHandler {
  const leaseStore = createD1ExecutionLeaseStore(database);
  return async (message) => {
    const intent = await loadAuthority(database, message);
    await requireActiveRevision(database, intent.payload_ref, message.payload_sha256);
    const prior = await findAcknowledgingReceipt(database, intent.intent_ref);
    if (prior !== null) return { receipt_ref: receiptString(prior) };

    const identity = `${intent.intent_ref.id}:${intent.intent_ref.revision}`;
    const operationId = await stableId("projection-accept", identity);
    const workerId = "eliotr-projection-acceptor";
    const acquiredAt = clock();
    const lease = await leaseStore.acquire({
      operation_id: operationId,
      operation_kind: "PROJECTION_ACCEPT",
      lease_owner: workerId,
      now_ms: acquiredAt,
      lease_ms: EXECUTION_LEASE_MS,
    });
    if (lease === null) {
      const current = await leaseStore.read(operationId);
      if (current?.state === "COMPLETED" && current.terminal_receipt_ref !== undefined) {
        return { receipt_ref: current.terminal_receipt_ref };
      }
      retryable("DELIVERY_LEASE_LOST", "another worker owns the projection acceptance fence");
    }
    const fence: ExecutionFence = {
      operation_id: lease.operation_id,
      lease_owner: lease.lease_owner,
      lease_generation: lease.lease_generation,
    };
    const createdAt = new Date(acquiredAt).toISOString();
    const jobId = await stableId("job-projection", identity);
    const attemptId = await stableId("attempt-projection", `${identity}:${lease.lease_generation}`);
    const receiptRef: VersionedRef = { id: await stableId("receipt-projection-accepted", identity), revision: 1 };
    const attempt: OperationAttempt = {
      attempt_id: attemptId,
      intent_ref: intent.intent_ref,
      attempt_number: lease.attempt,
      state: "STARTED",
      started_at: createdAt,
    };
    const receipt: OperationReceipt = {
      receipt_ref: receiptRef,
      intent_ref: intent.intent_ref,
      attempt_id: attemptId,
      outcome: "ACCEPTED",
      output_refs: [jobId],
      readback_receipt_refs: [`job:${jobId}`],
      reconciliation_required: true,
      reason_codes: ["PROJECTION_JOB_DURABLY_ACCEPTED"],
      created_at: createdAt,
    };
    try {
      await database.batch([
        database.prepare(
          "INSERT INTO operation_attempt(attempt_id, intent_id, intent_revision, attempt_number, state, started_at) " +
          "VALUES (?1,?2,?3,?4,'STARTED',?5)",
        ).bind(attemptId, intent.intent_ref.id, intent.intent_ref.revision, attempt.attempt_number, createdAt),
        database.prepare(
          "INSERT INTO job(job_id, intent_id, intent_revision, state, current_stage, created_at, updated_at) " +
          "VALUES (?1,?2,?3,'ACCEPTED','PROJECTION_QUEUED',?4,?4) ON CONFLICT(job_id) DO NOTHING",
        ).bind(jobId, intent.intent_ref.id, intent.intent_ref.revision, createdAt),
        database.prepare(
          "UPDATE operation_attempt SET state = 'CHECKPOINTED', checkpoint_ref = ?1 " +
          "WHERE attempt_id = ?2 AND state = 'STARTED'",
        ).bind(`job:${jobId}`, attemptId),
        database.prepare(
          "INSERT INTO operation_receipt(receipt_id, revision, intent_id, intent_revision, attempt_id, outcome, " +
          "output_refs_json, readback_receipt_refs_json, reconciliation_required, reason_codes_json, created_at) " +
          "VALUES (?1,?2,?3,?4,?5,'ACCEPTED',?6,?7,1,?8,?9) ON CONFLICT(receipt_id, revision) DO NOTHING",
        ).bind(
          receiptRef.id,
          receiptRef.revision,
          intent.intent_ref.id,
          intent.intent_ref.revision,
          attemptId,
          JSON.stringify(receipt.output_refs),
          JSON.stringify(receipt.readback_receipt_refs),
          JSON.stringify(receipt.reason_codes),
          createdAt,
        ),
      ]);
      await verifyAcceptedState(database, intent, jobId, attemptId, receipt);
    } catch (error) {
      const raced = await findAcknowledgingReceipt(database, intent.intent_ref);
      if (raced !== null) return { receipt_ref: receiptString(raced) };
      await failLeaseQuietly(leaseStore, fence, clock());
      retryable("DELIVERY_SETTLEMENT_UNCERTAIN", "projection acceptance transaction failed", error);
    }
    const durableReceipt = receiptString(receiptRef);
    try { await leaseStore.complete(fence, durableReceipt, clock()); } catch { /* receipt readback is authority */ }
    return { receipt_ref: durableReceipt };
  };
}
