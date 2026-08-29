import type { Env } from "./env.js";
import { readReadiness } from "./readiness.js";

export async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const readiness = await readReadiness(env);
  env.METRICS.writeDataPoint({
    blobs: ["scheduled", event.cron, readiness.ready ? "ready" : "blocked", env.DEPLOYMENT_GENERATION],
    doubles: [Date.now(), readiness.blocking_reason_codes.length],
    indexes: [event.cron],
  });
}
