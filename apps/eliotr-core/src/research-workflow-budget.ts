import { researchStageBudgetLeaseMs } from "./research-runtime-duration.js";
import { readD1BoundedWorkflowLeaseExpiry } from "@eliotr/cloudflare-workflows";

/**
 * Bound a newly issued workflow lease by both local and D1 wall clocks.
 * D1 enforces the absolute 10-minute cap at reservation time, so a Worker
 * clock ahead of D1 must not mint an expiry beyond D1's corresponding cap.
 */
export async function readD1BoundedResearchWorkflowLeaseExpiry(
  database: D1Database,
  stage: string,
  workerNowMs?: number,
): Promise<number | null> {
  return readD1BoundedWorkflowLeaseExpiry(database, researchStageBudgetLeaseMs(stage), workerNowMs);
}
