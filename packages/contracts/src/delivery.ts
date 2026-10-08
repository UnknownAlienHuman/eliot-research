export const DELIVERY_MESSAGE_PROTOCOL = "eliotr.delivery.message.v1" as const;

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

export interface OutboxClaimRequest {
  readonly worker_id: string;
  readonly now_ms: number;
  readonly lease_ms: number;
  readonly limit: number;
}

export interface InboxLease {
  readonly message_id: string;
  readonly topic: string;
  readonly idempotency_key: string;
  readonly lease_owner: string;
  readonly lease_generation: number;
  readonly attempt: number;
  readonly lease_until_ms: number;
}

export interface DeliveryHandlerContext {
  readonly message_id: string;
  readonly idempotency_key: string;
  readonly topic: string;
  readonly attempt: number;
}
