import type { OperationAttempt, OperationIntent, VersionedRef } from "@eliotr/contracts";
import type { QueueEnvelope } from "./outbox.js";

export type QueueMessageDisposition = "ACK" | "RETRY" | "DEAD_LETTER";

export interface DurableIntentPort {
  loadIntent(ref: VersionedRef): Promise<OperationIntent | null>;
  appendAttempt(attempt: OperationAttempt): Promise<void>;
  findTerminalReceipt(intentRef: VersionedRef): Promise<VersionedRef | null>;
}

export interface QueueOperationHandler {
  readonly operationKinds: readonly string[];
  execute(intent: OperationIntent, payloadRef: string): Promise<VersionedRef>;
}

export interface QueueDeliveryDecision {
  readonly disposition: QueueMessageDisposition;
  readonly retry_delay_seconds?: number;
  readonly reason_code: string;
  readonly terminal_receipt_ref?: VersionedRef;
}

export function queueEnvelopeIdentity(envelope: QueueEnvelope): string {
  return `${envelope.intent.intent_ref.id}@${envelope.intent.intent_ref.revision}:${envelope.intent.idempotency_key}`;
}

export function classifyQueueDelivery(input: {
  readonly existingTerminalReceipt: VersionedRef | null;
  readonly attemptNumber: number;
  readonly maximumAttempts: number;
  readonly retryableFailure: boolean;
  readonly failureCode?: string;
}): QueueDeliveryDecision {
  if (input.existingTerminalReceipt !== null) {
    return {
      disposition: "ACK",
      reason_code: "TERMINAL_RECEIPT_ALREADY_EXISTS",
      terminal_receipt_ref: input.existingTerminalReceipt,
    };
  }
  if (!input.retryableFailure) {
    return { disposition: "DEAD_LETTER", reason_code: input.failureCode ?? "NON_RETRYABLE_FAILURE" };
  }
  if (input.attemptNumber >= input.maximumAttempts) {
    return { disposition: "DEAD_LETTER", reason_code: input.failureCode ?? "MAXIMUM_ATTEMPTS_REACHED" };
  }
  return {
    disposition: "RETRY",
    retry_delay_seconds: Math.min(900, Math.max(5, 2 ** input.attemptNumber)),
    reason_code: input.failureCode ?? "RETRYABLE_FAILURE",
  };
}
