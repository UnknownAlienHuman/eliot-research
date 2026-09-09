import {
  createD1OutboxStore,
  createOutboxDispatcher,
  readD1OutboxHealth,
  type DeliveryMessage,
} from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";
import { cleanupExpiredGoogleOAuthIntents } from "./google-oauth-store.js";
import { readReadiness, REQUIRED_CORE_SCHEMA_GENERATION } from "./readiness.js";

const OUTBOX_BATCH_LIMIT = 50;

function metric(
  env: Env,
  event: ScheduledController,
  summary: Awaited<ReturnType<ReturnType<typeof createOutboxDispatcher>["dispatch"]>> | null,
  health: Awaited<ReturnType<typeof readD1OutboxHealth>> | null,
  state: "PASS" | "FAILED",
): void {
  try {
    env.METRICS.writeDataPoint({
      blobs: ["scheduled-outbox", event.cron, state, env.DEPLOYMENT_GENERATION],
      doubles: [
        summary?.claimed ?? 0,
        summary?.delivered ?? 0,
        summary?.scheduled_retry ?? 0,
        summary?.dead_lettered ?? 0,
        summary?.uncertain_settlements ?? 0,
        health?.pending ?? 0,
        health?.leased ?? 0,
        health?.failed ?? 0,
        health?.dead_lettered ?? 0,
        health?.invalid_payload_identity ?? 0,
        health?.oldest_unsent_age_ms ?? 0,
      ],
      indexes: [event.cron],
    });
  } catch {
    // Metrics failure does not mutate durable outbox state.
  }
}

// IMPLEMENTED_NOT_LIVE: ER-24 scheduled outbox reconciliation requires remote Queue send/readback receipts.
export async function handleScheduled(
  event: ScheduledController,
  env: Env,
): Promise<void> {
  // OAuth proof cleanup is maintenance only and runs after the core migration
  // gate is current. It is bounded and leaves admitted intents untouched.
  const readiness = await readReadiness(env);
  let lifecycleReady = false;
  try {
    const row = await env.CORE_DB.prepare(
      "SELECT value FROM schema_state WHERE key = 'google_oauth_lifecycle_generation'",
    ).first<{ value: string }>();
    lifecycleReady = row?.value === "google-oauth-lifecycle-v1";
  } catch {
    lifecycleReady = false;
  }
  if (readiness.core_schema_generation === REQUIRED_CORE_SCHEMA_GENERATION && lifecycleReady) {
    await cleanupExpiredGoogleOAuthIntents(env.CORE_DB, Date.now, 32);
  }
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

  let summary: Awaited<ReturnType<typeof dispatcher.dispatch>> | null = null;
  try {
    summary = await dispatcher.dispatch();
    const health = await readD1OutboxHealth(env.CORE_DB);
    metric(env, event, summary, health, "PASS");
    if (summary.uncertain_settlements > 0 || health.invalid_payload_identity > 0) {
      throw new Error("outbox contains uncertain settlement or invalid payload identity");
    }
  } catch (error) {
    metric(env, event, summary, null, "FAILED");
    if (error instanceof Error) throw error;
    throw new Error("scheduled outbox reconciliation failed with a non-Error cause", {
      cause: error,
    });
  }
}
