import type { DeliveryMessage } from "./delivery-types.js";

/** Transport diagnostics are separate from business completion and Inbox leases. */
export type QueueTerminalDisposition =
  | "MALFORMED"
  | "IDENTITY_MISMATCH"
  | "QUARANTINED"
  | "COMPLETED";

export interface QueueTerminalInput {
  readonly queue_name: string;
  readonly platform_message_id: string;
  readonly platform_attempt: number;
  readonly observed_at_ms: number;
  readonly message: DeliveryMessage | null;
}

export interface QueueTerminalObservation {
  readonly queue_name: string;
  readonly platform_message_id: string;
  readonly platform_attempt: number;
  readonly observed_at_ms: number;
  readonly disposition: QueueTerminalDisposition;
  /** Only exact canonical outbox metadata may be retained; never the raw body. */
  readonly original_message: DeliveryMessage | null;
  readonly completed_receipt_ref: string | null;
}

export interface QueueTerminalStore {
  /** Resolve only after the immutable observation has exact durable readback. */
  record(input: QueueTerminalInput): Promise<QueueTerminalObservation>;
}

export interface DlqConsumerOptions {
  readonly queue_name: string;
  readonly retry_delay_seconds: number;
  readonly now?: () => number;
}
