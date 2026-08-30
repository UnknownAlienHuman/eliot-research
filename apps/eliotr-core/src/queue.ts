import {
  createD1InboxStore,
  createQueueConsumerRuntime,
  type QueueConsumptionResult,
} from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";
import { createProjectionDeliveryHandler } from "./projection-delivery-handler.js";

const CONSUMER_WORKER_ID = "eliotr-queue-consumer";
const CONSUMER_LEASE_MS = 60_000;
const PLATFORM_OWNS_TERMINAL_RETRY = 10_000;

function metric(env: Env, result: QueueConsumptionResult | null, reason: string): void {
  try {
    env.METRICS.writeDataPoint({
      blobs: [
        "queue",
        result?.disposition ?? "UNEXPECTED_FAILURE",
        result?.error_code ?? reason,
        env.DEPLOYMENT_GENERATION,
      ],
      doubles: [result === null ? 0 : 1],
      indexes: [result?.disposition ?? "UNEXPECTED_FAILURE"],
    });
  } catch {
    // Metrics are observational and never change acknowledgement semantics.
  }
}

// IMPLEMENTED_NOT_LIVE: ER-24 Queue dispatch requires remote duplicate-delivery and DLQ receipts.
export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const runtime = createQueueConsumerRuntime(
    createD1InboxStore(env.CORE_DB),
    {
      worker_id: CONSUMER_WORKER_ID,
      lease_ms: CONSUMER_LEASE_MS,
      // Cloudflare's configured max_retries and DLQ own poison-message termination. Keeping this
      // internal ceiling above the platform retry count prevents an application ACK from bypassing DLQ.
      maximum_attempts: PLATFORM_OWNS_TERMINAL_RETRY,
      retry_base_ms: 5_000,
      retry_maximum_ms: 5 * 60_000,
    },
  );
  const handler = createProjectionDeliveryHandler(env.CORE_DB);

  for (const message of batch.messages) {
    try {
      const result = await runtime.consume(message, handler);
      metric(env, result, "QUEUE_DELIVERY_HANDLED");
    } catch {
      // Malformed envelopes and unexpected runtime failures are never acknowledged. Cloudflare moves
      // them to the configured DLQ after max_retries, preserving poison-message evidence.
      metric(env, null, "QUEUE_CONSUMER_UNEXPECTED_FAILURE");
      message.retry({ delaySeconds: 0 });
    }
  }
}
