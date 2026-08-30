import { OperationIntentSchema, type OperationIntent, type VersionedRef } from "@eliotr/contracts";
import {
  DeliveryRuntimeError,
  assertDeliveryIdentifier,
  assertPayloadRef,
  type DeliveryRuntimeErrorCode,
} from "./delivery-types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const TOPIC = /^[a-z][a-z0-9._-]{0,127}$/u;

interface AuthorityRow {
  readonly intent_id: unknown;
  readonly revision: unknown;
  readonly operation_kind: unknown;
  readonly principal_ref: unknown;
  readonly idempotency_key: unknown;
  readonly payload_ref: unknown;
  readonly policy_decision_ref: unknown;
  readonly budget_reservation_ref: unknown;
  readonly cancellation_ref: unknown;
  readonly created_at: unknown;
  readonly outbox_id: unknown;
  readonly topic: unknown;
  readonly payload_sha256: unknown;
}

export interface AppendOutboxIntentInput {
  readonly intent: OperationIntent;
  readonly topic: string;
  readonly payload_sha256: string;
}

export interface AppendOutboxIntentResult {
  readonly intent_ref: VersionedRef;
  readonly outbox_id: string;
  readonly disposition: "CREATED" | "EXISTING";
}

function fail(code: DeliveryRuntimeErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new DeliveryRuntimeError(code, message, retryable, cause);
}

async function stableOutboxId(ref: VersionedRef): Promise<string> {
  const bytes = new TextEncoder().encode(`outbox\u0000${ref.id}\u0000${ref.revision}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `outbox-${hex.slice(0, 48)}`;
}

function decode(row: AuthorityRow): { readonly intent: OperationIntent; readonly outbox_id: string; readonly topic: string; readonly payload_sha256: string } {
  const intent = OperationIntentSchema.parse({
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
  assertDeliveryIdentifier(row.outbox_id, "outbox_id");
  if (typeof row.topic !== "string" || !TOPIC.test(row.topic)) fail("DELIVERY_INPUT_INVALID", "outbox topic is invalid");
  if (typeof row.payload_sha256 !== "string" || !SHA256.test(row.payload_sha256)) {
    fail("DELIVERY_INPUT_INVALID", "outbox payload digest is invalid");
  }
  return { intent, outbox_id: row.outbox_id, topic: row.topic, payload_sha256: row.payload_sha256 };
}

function sameIntent(left: OperationIntent, right: OperationIntent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readByIdempotency(
  database: D1Database,
  operationKind: string,
  idempotencyKey: string,
): Promise<ReturnType<typeof decode> | null> {
  const row = await database.prepare(
    "SELECT i.intent_id, i.revision, i.operation_kind, i.principal_ref, i.idempotency_key, " +
    "i.payload_ref, i.policy_decision_ref, i.budget_reservation_ref, i.cancellation_ref, i.created_at, " +
    "o.outbox_id, o.topic, o.payload_sha256 FROM operation_intent i JOIN outbox o " +
    "ON o.intent_id = i.intent_id AND o.intent_revision = i.revision " +
    "WHERE i.operation_kind = ?1 AND i.idempotency_key = ?2 LIMIT 1",
  ).bind(operationKind, idempotencyKey).first<AuthorityRow>();
  return row === null ? null : decode(row);
}

function assertExact(
  existing: ReturnType<typeof decode>,
  input: AppendOutboxIntentInput,
  expectedOutboxId: string,
): void {
  if (
    !sameIntent(existing.intent, input.intent) ||
    existing.outbox_id !== expectedOutboxId ||
    existing.topic !== input.topic ||
    existing.payload_sha256 !== input.payload_sha256
  ) {
    fail("DELIVERY_INPUT_INVALID", "idempotency identity is already bound to different intent or payload bytes");
  }
}

export async function appendIntentWithOutbox(
  database: D1Database,
  rawInput: AppendOutboxIntentInput,
): Promise<AppendOutboxIntentResult> {
  let intent: OperationIntent;
  try {
    intent = OperationIntentSchema.parse(rawInput.intent);
  } catch (error) {
    fail("DELIVERY_INPUT_INVALID", "operation intent failed strict contract validation", false, error);
  }
  if (!TOPIC.test(rawInput.topic)) fail("DELIVERY_INPUT_INVALID", "topic is invalid");
  if (!SHA256.test(rawInput.payload_sha256)) fail("DELIVERY_INPUT_INVALID", "payload_sha256 is invalid");
  assertPayloadRef(intent.payload_ref);
  const input = { intent, topic: rawInput.topic, payload_sha256: rawInput.payload_sha256 };
  const outboxId = await stableOutboxId(intent.intent_ref);
  const existing = await readByIdempotency(database, intent.operation_kind, intent.idempotency_key);
  if (existing !== null) {
    assertExact(existing, input, outboxId);
    return { intent_ref: existing.intent.intent_ref, outbox_id: existing.outbox_id, disposition: "EXISTING" };
  }
  const nextAttemptAt = Date.parse(intent.created_at);
  if (!Number.isSafeInteger(nextAttemptAt) || nextAttemptAt < 0) fail("DELIVERY_INPUT_INVALID", "intent created_at is invalid");
  try {
    const results = await database.batch([
      database.prepare(
        "INSERT INTO operation_intent(intent_id, revision, operation_kind, principal_ref, idempotency_key, payload_ref, " +
        "policy_decision_ref, budget_reservation_ref, cancellation_ref, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
      ).bind(
        intent.intent_ref.id,
        intent.intent_ref.revision,
        intent.operation_kind,
        intent.principal_ref,
        intent.idempotency_key,
        intent.payload_ref,
        intent.policy_decision_ref,
        intent.budget_reservation_ref ?? null,
        intent.cancellation_ref ?? null,
        intent.created_at,
      ),
      database.prepare(
        "INSERT INTO outbox(outbox_id, intent_id, intent_revision, topic, payload_ref, payload_sha256, state, attempts, " +
        "next_attempt_at, lease_generation, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,'PENDING',0,?7,0,?8,?8)",
      ).bind(
        outboxId,
        intent.intent_ref.id,
        intent.intent_ref.revision,
        input.topic,
        intent.payload_ref,
        input.payload_sha256,
        nextAttemptAt,
        intent.created_at,
      ),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
      fail("DELIVERY_SETTLEMENT_UNCERTAIN", "intent/outbox batch did not mutate exactly two rows", true);
    }
  } catch (error) {
    const raced = await readByIdempotency(database, intent.operation_kind, intent.idempotency_key);
    if (raced !== null) {
      assertExact(raced, input, outboxId);
      return { intent_ref: raced.intent.intent_ref, outbox_id: raced.outbox_id, disposition: "EXISTING" };
    }
    if (error instanceof DeliveryRuntimeError) throw error;
    fail("DELIVERY_SETTLEMENT_UNCERTAIN", "intent/outbox atomic append failed", true, error);
  }
  const readback = await readByIdempotency(database, intent.operation_kind, intent.idempotency_key);
  if (readback === null) fail("DELIVERY_SETTLEMENT_UNCERTAIN", "intent/outbox readback is missing", true);
  assertExact(readback, input, outboxId);
  return { intent_ref: readback.intent.intent_ref, outbox_id: readback.outbox_id, disposition: "CREATED" };
}
