import type { OperationIntent, VersionedRef } from "@eliotr/contracts";

export interface OutboxRecord {
  readonly outbox_id: string;
  readonly intent_ref: VersionedRef;
  readonly topic: string;
  readonly payload_ref: string;
  readonly attempts: number;
  readonly next_attempt_at: number;
  readonly state: "PENDING" | "SENT" | "FAILED" | "DEAD_LETTERED";
}

export interface OutboxRepository {
  claimBatch(limit: number, leaseOwner: string, leaseUntil: number): Promise<readonly OutboxRecord[]>;
  markSent(outboxId: string, queueMessageId: string): Promise<void>;
  releaseForRetry(outboxId: string, nextAttemptAt: number, errorCode: string): Promise<void>;
  markDeadLettered(outboxId: string, errorCode: string): Promise<void>;
}

export interface QueueEnvelope {
  readonly protocol: "eliotr.queue.v1";
  readonly intent: OperationIntent;
  readonly payload_ref: string;
  readonly enqueued_at: string;
}

export interface OutboxDispatcher {
  dispatch(limit: number): Promise<{ sent: number; retried: number; dead_lettered: number }>;
  reconcileLostAcknowledgements(limit: number): Promise<number>;
}

export const QUEUE_IS_ACCELERATION_NOT_AUTHORITY = true as const;
