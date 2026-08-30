export const DELIVERY_MESSAGE_PROTOCOL = "eliotr.delivery.message.v1" as const;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_PAYLOAD_REF_BYTES = 1024;
const MAX_ERROR_CODE_BYTES = 128;
const MAX_TIMESTAMP_MS = 253_402_300_799_999;
const MAX_OUTBOX_ID_FOR_MESSAGE = 250;

export type DeliveryRuntimeErrorCode =
  | "DELIVERY_INPUT_INVALID"
  | "DELIVERY_LEASE_LOST"
  | "DELIVERY_QUEUE_REJECTED"
  | "DELIVERY_SETTLEMENT_UNCERTAIN"
  | "DELIVERY_INBOX_UNAVAILABLE"
  | "DELIVERY_HANDLER_FAILED";

export class DeliveryRuntimeError extends Error {
  public readonly code: DeliveryRuntimeErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: DeliveryRuntimeErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DeliveryRuntimeError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface OutboxLease {
  readonly outbox_id: string;
  readonly topic: string;
  readonly payload_ref: string;
  readonly payload_sha256: string;
  readonly idempotency_key: string;
  readonly attempt: number;
  readonly lease_owner: string;
  readonly lease_generation: number;
  readonly lease_until_ms: number;
  readonly created_at_ms: number;
}

export interface DeliveryMessage {
  readonly protocol: typeof DELIVERY_MESSAGE_PROTOCOL;
  readonly message_id: string;
  readonly topic: string;
  readonly payload_ref: string;
  readonly payload_sha256: string;
  readonly idempotency_key: string;
  readonly outbox_id: string;
  readonly outbox_attempt: number;
  readonly created_at_ms: number;
}

export interface QueueSendReceipt {
  readonly queue_message_ref: string;
  readonly accepted_at_ms: number;
}

export interface DeliveryProducer {
  send(message: DeliveryMessage): Promise<QueueSendReceipt>;
}

export interface OutboxClaimRequest {
  readonly worker_id: string;
  readonly now_ms: number;
  readonly lease_ms: number;
  readonly limit: number;
}

export interface OutboxStore {
  claimBatch(request: OutboxClaimRequest): Promise<readonly OutboxLease[]>;
  markDelivered(
    lease: OutboxLease,
    receipt: QueueSendReceipt,
    settledAtMs: number,
  ): Promise<void>;
  markRetry(
    lease: OutboxLease,
    availableAtMs: number,
    errorCode: string,
    settledAtMs: number,
  ): Promise<void>;
  markDeadLetter(
    lease: OutboxLease,
    errorCode: string,
    settledAtMs: number,
  ): Promise<void>;
}

export type InboxBeginDisposition =
  | "ACQUIRED"
  | "DUPLICATE_COMPLETED"
  | "DUPLICATE_PROCESSING";

export interface InboxLease {
  readonly message_id: string;
  readonly topic: string;
  readonly idempotency_key: string;
  readonly lease_owner: string;
  readonly lease_generation: number;
  readonly attempt: number;
  readonly lease_until_ms: number;
}

export interface InboxBeginResult {
  readonly disposition: InboxBeginDisposition;
  readonly lease?: InboxLease;
  readonly prior_receipt_ref?: string;
}

export interface InboxStore {
  begin(input: {
    readonly message: DeliveryMessage;
    readonly worker_id: string;
    readonly now_ms: number;
    readonly lease_ms: number;
  }): Promise<InboxBeginResult>;
  complete(lease: InboxLease, receiptRef: string, completedAtMs: number): Promise<void>;
  retryableFailure(
    lease: InboxLease,
    errorCode: string,
    availableAtMs: number,
    failedAtMs: number,
  ): Promise<void>;
  terminalFailure(lease: InboxLease, errorCode: string, failedAtMs: number): Promise<void>;
}

export interface QueueDelivery {
  readonly body: unknown;
  ack(): void;
  retry(options?: { readonly delaySeconds?: number }): void;
}

export interface DeliveryHandlerContext {
  readonly message_id: string;
  readonly idempotency_key: string;
  readonly topic: string;
  readonly attempt: number;
}

export type DeliveryHandler = (
  message: DeliveryMessage,
  context: DeliveryHandlerContext,
) => Promise<{ readonly receipt_ref: string }>;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertDeliveryIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", `${label} is invalid`);
  }
}

export function assertDeliveryTimestamp(value: unknown, label: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    throw new DeliveryRuntimeError(
      "DELIVERY_INPUT_INVALID",
      `${label} is outside the supported timestamp range`,
    );
  }
}

export function assertPositiveInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", `${label} is outside its allowed range`);
  }
}

export function assertPayloadRef(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    utf8Bytes(value) > MAX_PAYLOAD_REF_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "payload_ref is invalid");
  }
}

export function assertErrorCode(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    utf8Bytes(value) > MAX_ERROR_CODE_BYTES ||
    !/^[A-Z0-9][A-Z0-9_:-]*$/u.test(value)
  ) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "error code is invalid");
  }
}

export function validateOutboxLease(value: OutboxLease, nowMs: number): OutboxLease {
  assertDeliveryIdentifier(value.outbox_id, "outbox_id");
  if (value.outbox_id.length > MAX_OUTBOX_ID_FOR_MESSAGE) {
    throw new DeliveryRuntimeError(
      "DELIVERY_INPUT_INVALID",
      "outbox_id leaves no room for the attempt suffix in message_id",
    );
  }
  assertDeliveryIdentifier(value.topic, "topic");
  assertPayloadRef(value.payload_ref);
  if (!SHA256.test(value.payload_sha256)) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "payload_sha256 is invalid");
  }
  assertDeliveryIdentifier(value.idempotency_key, "idempotency_key");
  assertPositiveInteger(value.attempt, "attempt", 10_000);
  assertDeliveryIdentifier(value.lease_owner, "lease_owner");
  assertPositiveInteger(value.lease_generation, "lease_generation");
  assertDeliveryTimestamp(value.lease_until_ms, "lease_until_ms");
  assertDeliveryTimestamp(value.created_at_ms, "created_at_ms");
  assertDeliveryTimestamp(nowMs, "now_ms");
  if (value.lease_until_ms <= nowMs) {
    throw new DeliveryRuntimeError("DELIVERY_LEASE_LOST", "outbox lease is already expired", true);
  }
  return value;
}

export function decodeDeliveryMessage(value: unknown): DeliveryMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "delivery message must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "protocol",
    "message_id",
    "topic",
    "payload_ref",
    "payload_sha256",
    "idempotency_key",
    "outbox_id",
    "outbox_attempt",
    "created_at_ms",
  ]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    record.protocol !== DELIVERY_MESSAGE_PROTOCOL
  ) {
    throw new DeliveryRuntimeError(
      "DELIVERY_INPUT_INVALID",
      "delivery message protocol or fields are invalid",
    );
  }
  assertDeliveryIdentifier(record.message_id, "message_id");
  assertDeliveryIdentifier(record.topic, "topic");
  assertPayloadRef(record.payload_ref);
  if (typeof record.payload_sha256 !== "string" || !SHA256.test(record.payload_sha256)) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "payload_sha256 is invalid");
  }
  assertDeliveryIdentifier(record.idempotency_key, "idempotency_key");
  assertDeliveryIdentifier(record.outbox_id, "outbox_id");
  assertPositiveInteger(record.outbox_attempt, "outbox_attempt", 10_000);
  assertDeliveryTimestamp(record.created_at_ms, "created_at_ms");
  const message: DeliveryMessage = {
    protocol: DELIVERY_MESSAGE_PROTOCOL,
    message_id: record.message_id,
    topic: record.topic,
    payload_ref: record.payload_ref,
    payload_sha256: record.payload_sha256,
    idempotency_key: record.idempotency_key,
    outbox_id: record.outbox_id,
    outbox_attempt: record.outbox_attempt,
    created_at_ms: record.created_at_ms,
  };
  if (message.message_id !== `${message.outbox_id}:${message.outbox_attempt}`) {
    throw new DeliveryRuntimeError(
      "DELIVERY_INPUT_INVALID",
      "message_id is not bound to outbox_id and outbox_attempt",
    );
  }
  return message;
}

export function messageFromLease(lease: OutboxLease): DeliveryMessage {
  validateOutboxLease(lease, lease.lease_until_ms - 1);
  return decodeDeliveryMessage({
    protocol: DELIVERY_MESSAGE_PROTOCOL,
    message_id: `${lease.outbox_id}:${lease.attempt}`,
    topic: lease.topic,
    payload_ref: lease.payload_ref,
    payload_sha256: lease.payload_sha256,
    idempotency_key: lease.idempotency_key,
    outbox_id: lease.outbox_id,
    outbox_attempt: lease.attempt,
    created_at_ms: lease.created_at_ms,
  });
}

export function retryDelayMs(attempt: number, baseMs: number, maximumMs: number): number {
  assertPositiveInteger(attempt, "attempt", 10_000);
  assertPositiveInteger(baseMs, "baseMs");
  assertPositiveInteger(maximumMs, "maximumMs");
  if (baseMs > maximumMs) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "baseMs exceeds maximumMs");
  }
  const exponent = Math.min(attempt - 1, 20);
  return Math.min(maximumMs, baseMs * (2 ** exponent));
}
