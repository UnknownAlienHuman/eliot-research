import {
  createD1InboxStore,
  createD1QueueTerminalStore,
  createDlqConsumerRuntime,
  createQueueConsumerRuntime,
  queueDeliveryMetric,
  type QueueDeliveryMetricInput,
  type DeliveryHandler,
} from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";
import { createProjectionDeliveryHandler } from "@eliotr/cloudflare-projection";
import { createProjectionExecutionDeliveryHandler } from "@eliotr/cloudflare-ai";
import { createExternalTaskResultDeliveryHandler, EXTERNAL_AGENT_RESULT_WAKE_TOPIC } from "@eliotr/cloudflare-workflows";
import { createProjectMembershipIndexDeliveryHandler, PROJECT_MEMBERSHIP_INDEX_TOPIC } from "./project-membership-index-delivery.js";

const CONSUMER_WORKER_ID = "eliotr-queue-consumer";
const CONSUMER_LEASE_MS = 60_000;
const CONSUMER_RETRY_DELAY_SECONDS = 30;

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
  const membershipIndex = createProjectMembershipIndexDeliveryHandler(env);
  const externalResult = createExternalTaskResultDeliveryHandler({
    database: env.CORE_DB,
    get_instance: (operationId) => env.RESEARCH_WORKFLOW.get(operationId),
  });
  return (message, context) => {
    if (message.topic === EXTERNAL_AGENT_RESULT_WAKE_TOPIC) return externalResult(message, context);
    if (message.topic === PROJECT_MEMBERSHIP_INDEX_TOPIC) return membershipIndex(message, context);
    return projection(message, context);
  };
}

// IMPLEMENTED_NOT_LIVE: ER-24 Queue dispatch requires remote duplicate-delivery and DLQ receipts.
export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  if (batch.queue === "eliotr-dlq" || batch.queue === "eliotr-dlq-test") {
    const terminal = createDlqConsumerRuntime(createD1QueueTerminalStore(env.CORE_DB), {
      queue_name: batch.queue,
      retry_delay_seconds: CONSUMER_RETRY_DELAY_SECONDS,
    });
    for (const message of batch.messages) {
      try {
        const observation = await terminal.consume(message);
        try {
          env.METRICS.writeDataPoint({
            indexes: ["queue-dlq"],
            blobs: ["queue", "DLQ", observation.disposition, observation.queue_name,
              observation.platform_message_id],
            doubles: [observation.platform_attempt],
          });
        } catch {
          // The durable diagnostic is already acknowledged; observational metrics cannot undo it.
        }
      } catch (error) {
        // The DLQ runtime has already marked this message for native retry. Never retry twice.
        try {
          metric(env, {
            result: null,
            deployment_generation: env.DEPLOYMENT_GENERATION,
            failure: { error, platform_message_id: message.id, attempt: message.attempts },
          });
        } catch {
          // Native metadata access itself may fail; do not expose arbitrary error text.
        }
        // If native retry itself throws, successful handler return must not auto-ACK the batch.
        // eslint-disable-next-line preserve-caught-error -- Original transport error/cause may contain private payload text.
        throw new Error("DLQ_SETTLEMENT_UNCERTAIN");
      }
    }
    return;
  }
  if (batch.queue !== "eliotr-jobs" && batch.queue !== "eliotr-jobs-test") {
    // A successful return would auto-ACK an unknown batch. Reject it before constructing a handler.
    throw new Error("QUEUE_NAME_UNRECOGNIZED");
  }
  const runtime = createQueueConsumerRuntime(
    createD1InboxStore(env.CORE_DB),
    {
      worker_id: CONSUMER_WORKER_ID,
      lease_ms: CONSUMER_LEASE_MS,
      terminal_policy: "PLATFORM_DLQ",
      retry_delay_seconds: CONSUMER_RETRY_DELAY_SECONDS,
    },
  );
  const handler = deliveryHandler(env);

  for (const message of batch.messages) {
    try {
      const result = await runtime.consume(message, handler);
      metric(env, { result, deployment_generation: env.DEPLOYMENT_GENERATION });
    } catch (error) {
      // The bounded diagnostic excludes the thrown message and Queue body. Malformed messages and
      // unexpected failures remain unacknowledged for Cloudflare's max_retries/DLQ.
      // Every primary retry uses the same installed delay, including failures before inbox acquisition.
      metric(env, {
        result: null,
        deployment_generation: env.DEPLOYMENT_GENERATION,
        failure: { error, platform_message_id: message.id, attempt: message.attempts },
      });
      message.retry({ delaySeconds: CONSUMER_RETRY_DELAY_SECONDS });
    }
  }
}
