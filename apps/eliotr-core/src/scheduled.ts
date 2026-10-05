import {
  createD1OutboxStore,
  createOutboxDispatcher,
  readD1OutboxHealth,
  scheduledOutboxMetric,
  type ScheduledOutboxMetricInput,
  type DeliveryMessage,
} from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";
import { cleanupExpiredGoogleOAuthIntents } from "./google-oauth-store.js";
import { readReadiness, REQUIRED_CORE_SCHEMA_GENERATION } from "./readiness.js";

const OUTBOX_BATCH_LIMIT = 50;

function metric(env: Env, input: ScheduledOutboxMetricInput): void {
  try {
    env.METRICS.writeDataPoint(scheduledOutboxMetric(input));
  } catch {
    // Metrics failure does not mutate durable outbox state.
  }
}

// IMPLEMENTED_NOT_LIVE: ER-24 scheduled outbox reconciliation requires remote Queue send/readback receipts.
export async function handleScheduled(
  event: ScheduledController,
  env: Env,
): Promise<void> {
  // Housekeeping is bounded and independent of outbox delivery. Preserve its
  // outcome and surface failures after dispatch so maintenance cannot starve jobs.
  let housekeeping: "SKIPPED" | "PASS" | "FAILED" = "SKIPPED";
  let housekeepingError: unknown;
  try {
    const readiness = await readReadiness(env);
    if (readiness.core_schema_generation === REQUIRED_CORE_SCHEMA_GENERATION) {
      const row = await env.CORE_DB.prepare(
        "SELECT value FROM schema_state WHERE key = 'google_oauth_lifecycle_generation'",
      ).first<{ value: string }>();
      if (row?.value === "google-oauth-lifecycle-v1") {
        await cleanupExpiredGoogleOAuthIntents(env.CORE_DB, Date.now, 32);
        housekeeping = "PASS";
      }
    }
  } catch (error) {
    housekeeping = "FAILED";
    housekeepingError = error;
  }

  let summary: Awaited<ReturnType<ReturnType<typeof createOutboxDispatcher>["dispatch"]>> | null = null;
  let health: Awaited<ReturnType<typeof readD1OutboxHealth>> | null = null;
  let dispatchState: "PASS" | "FAILED" = "PASS";
  let dispatchError: unknown;
  try {
    const store = createD1OutboxStore(env.CORE_DB);
    const dispatcher = createOutboxDispatcher(
      store,
      {
        async send(message: DeliveryMessage) {
          await env.JOB_QUEUE.send(message);
          return {
            // Queue.send() completion is not a provider readback. The stable application message ID is
            // retained so a lost producer ACK replays the same idempotency identity.
            queue_message_ref: message.message_id,
            accepted_at_ms: Date.now(),
          };
        },
      },
      {
        worker_id: "eliotr-outbox-dispatcher",
        lease_ms: 45_000,
        batch_limit: OUTBOX_BATCH_LIMIT,
        maximum_attempts: 10,
        retry_base_ms: 5_000,
        retry_maximum_ms: 15 * 60_000,
      },
    );
    summary = await dispatcher.dispatch();
    health = await readD1OutboxHealth(env.CORE_DB);
    if (summary.uncertain_settlements > 0 || health.invalid_payload_identity > 0) {
      throw new Error("outbox contains uncertain settlement or invalid payload identity");
    }
  } catch (error) {
    dispatchState = "FAILED";
    dispatchError = error;
  }

  const state = dispatchState === "FAILED" || housekeeping === "FAILED" ? "FAILED" : "PASS";
  metric(env, {
    cron: event.cron, deployment_generation: env.DEPLOYMENT_GENERATION,
    summary, health, state, housekeeping, dispatch: dispatchState,
  });

  if (dispatchState === "FAILED" && housekeeping === "FAILED") {
    throw new AggregateError(
      [dispatchError, housekeepingError],
      "scheduled outbox reconciliation and housekeeping failed",
    );
  }
  if (dispatchState === "FAILED") {
    if (dispatchError instanceof Error) throw dispatchError;
    throw new Error("scheduled outbox reconciliation failed with a non-Error cause", {
      cause: dispatchError,
    });
  }
  if (housekeeping === "FAILED") {
    throw new Error("scheduled OAuth intent housekeeping failed", { cause: housekeepingError });
  }
}
