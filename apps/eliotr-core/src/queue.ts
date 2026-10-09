import {
  createD1InboxStore,
  createQueueConsumerRuntime,
  queueDeliveryMetric,
  type QueueDeliveryMetricInput,
  type DeliveryHandler,
} from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";
import { createProjectionDeliveryHandler } from "@eliotr/cloudflare-projection";
import { createProjectionExecutionDeliveryHandler } from "@eliotr/cloudflare-ai";
import { createExternalTaskResultDeliveryHandler, EXTERNAL_AGENT_RESULT_WAKE_TOPIC } from "@eliotr/cloudflare-workflows";

const CONSUMER_WORKER_ID = "eliotr-queue-consumer";
const CONSUMER_LEASE_MS = 60_000;
const PLATFORM_OWNS_TERMINAL_RETRY = 10_000;

function metric(env: Env, input: QueueDeliveryMetricInput): void {
  try {
    env.METRICS.writeDataPoint(queueDeliveryMetric(input));
  } catch {
    // Metrics are observational and never change acknowledgement semantics.
  }
}

function projectionHandler(env: Env): DeliveryHandler {
  const accept = createProjectionDeliveryHandler(env.CORE_DB);
  const execute = createProjectionExecutionDeliveryHandler({
    core_database: env.CORE_DB,
    search_database: env.SEARCH_DB,
    evidence_bucket: env.EVIDENCE_BUCKET,
    work_bucket: env.WORK_BUCKET,
    ai_search: env.AI_SEARCH,
  });
  return async (message, context) => {
    await accept(message, context);
    return execute(message, context);
  };
}

function deliveryHandler(env: Env): DeliveryHandler {
  const projection = projectionHandler(env);
  const externalResult = createExternalTaskResultDeliveryHandler({
    database: env.CORE_DB,
    get_instance: (operationId) => env.RESEARCH_WORKFLOW.get(operationId),
  });
  return (message, context) => message.topic === EXTERNAL_AGENT_RESULT_WAKE_TOPIC
    ? externalResult(message, context)
    : projection(message, context);
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
  const handler = deliveryHandler(env);

  for (const message of batch.messages) {
    try {
      const result = await runtime.consume(message, handler);
      metric(env, { result, deployment_generation: env.DEPLOYMENT_GENERATION });
    } catch (error) {
      // The bounded diagnostic excludes the thrown message and Queue body. Malformed messages and
      // unexpected failures remain unacknowledged for the configured retry delay/max_retries/DLQ.
      // Omitting per-message delaySeconds preserves the consumer's configured retry_delay.
      metric(env, {
        result: null,
        deployment_generation: env.DEPLOYMENT_GENERATION,
        failure: { error, platform_message_id: message.id, attempt: message.attempts },
      });
      message.retry();
    }
  }
}
