import { DeliveryRuntimeError } from "./delivery-types.js";
import type { QueueConsumptionResult } from "./queue-consumer.js";
import type { OutboxDispatchSummary } from "./outbox-dispatcher.js";
import type { OutboxHealth } from "./d1-outbox-store.js";

const SAFE_ERROR_CODES = new Set<string>([
  "DELIVERY_INPUT_INVALID",
  "DELIVERY_LEASE_LOST",
  "DELIVERY_QUEUE_REJECTED",
  "DELIVERY_SETTLEMENT_UNCERTAIN",
  "DELIVERY_INBOX_UNAVAILABLE",
  "DELIVERY_HANDLER_FAILED",
]);
const SAFE_DISPOSITIONS = new Set([
  "COMPLETED", "DUPLICATE_ACKNOWLEDGED", "RETRY_SCHEDULED",
  "TERMINAL_FAILURE_RECORDED", "SETTLEMENT_UNCERTAIN",
]);

export interface QueueDeliveryMetricInput {
  readonly deployment_generation: string;
  readonly result: QueueConsumptionResult | null;
  readonly failure?: {
    readonly error: unknown;
    readonly platform_message_id: unknown;
    readonly attempt: unknown;
  };
}

export interface ScheduledOutboxMetricInput {
  readonly cron: string;
  readonly deployment_generation: string;
  readonly summary: OutboxDispatchSummary | null;
  readonly health: OutboxHealth | null;
  readonly state: "PASS" | "FAILED";
  readonly housekeeping: "PASS" | "FAILED" | "SKIPPED";
  readonly dispatch: "PASS" | "FAILED";
}

// These fields are trusted platform/configuration identifiers, never exception text or payload fields.
// Reject malformed identifiers rather than retaining a sanitized URL, token, or arbitrary text.
function identifier(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && !/^[^.]+\.[^.]+\.[^.]+$/u.test(value)
    ? value : "unknown";
}

function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum) : 0;
}

export function queueDeliveryMetric(input: QueueDeliveryMetricInput): AnalyticsEngineDataPoint {
  const disposition = input.result !== null && SAFE_DISPOSITIONS.has(input.result.disposition)
    ? input.result.disposition : "UNEXPECTED_FAILURE";
  const reason = input.result === null ? "QUEUE_CONSUMER_UNEXPECTED_FAILURE" : "QUEUE_DELIVERY_HANDLED";
  const rawCode = input.result?.error_code;
  let code = rawCode !== undefined && (SAFE_ERROR_CODES.has(rawCode) || rawCode === "DUPLICATE_PROCESSING") ? rawCode : reason;
  const blobs = ["queue", disposition, code, identifier(input.deployment_generation)];
  const doubles = [input.result === null ? 0 : 1];
  if (input.failure !== undefined) {
    const { error } = input.failure;
    let cause: string;
    if (error instanceof DeliveryRuntimeError && SAFE_ERROR_CODES.has(error.code)) {
      code = error.code;
      cause = error.code === "DELIVERY_INPUT_INVALID" ? "MALFORMED_MESSAGE"
        : error.retryable ? "RETRYABLE_RUNTIME_FAILURE" : "PERMANENT_RUNTIME_FAILURE";
    } else {
      cause = error instanceof Error ? "UNEXPECTED_EXCEPTION" : "NON_ERROR_THROW";
      code = "QUEUE_CONSUMER_UNEXPECTED_FAILURE";
    }
    blobs[2] = code;
    blobs.push(cause, identifier(input.failure.platform_message_id));
    doubles.push(count(input.failure.attempt, 1_000_000));
  }
  return { blobs, doubles, indexes: [disposition] };
}

export function scheduledOutboxMetric(input: ScheduledOutboxMetricInput): AnalyticsEngineDataPoint {
  const cron = /^[0-9*/,\- ]{1,96}$/u.test(input.cron) ? input.cron : "unknown";
  return {
    blobs: ["scheduled-outbox", cron, input.state, identifier(input.deployment_generation),
      input.housekeeping, input.dispatch],
    doubles: [
      count(input.summary?.claimed),
      count(input.summary?.delivered),
      count(input.summary?.scheduled_retry),
      count(input.summary?.dead_lettered),
      count(input.summary?.uncertain_settlements),
      count(input.health?.pending),
      count(input.health?.leased),
      count(input.health?.failed),
      count(input.health?.dead_lettered),
      count(input.health?.invalid_payload_identity),
      count(input.health?.oldest_unsent_age_ms),
    ],
    indexes: [cron],
  };
}
