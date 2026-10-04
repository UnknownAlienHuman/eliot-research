import { researchStageBudgetLeaseMs } from "./research-runtime-duration.js";

interface D1ClockRow {
  readonly now_ms: number;
}

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
  const durationMs = researchStageBudgetLeaseMs(stage);
  if ((workerNowMs !== undefined && !Number.isSafeInteger(workerNowMs)) ||
      !Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 600_000) {
    return null;
  }

  let row: D1ClockRow | null;
  try {
    row = await database.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms")
      .first<D1ClockRow>();
  } catch {
    return null;
  }
  if (row === null || !Number.isSafeInteger(row.now_ms) || row.now_ms <= 0) return null;

  const currentWorkerNowMs = workerNowMs ?? Date.now();
  if (!Number.isSafeInteger(currentWorkerNowMs)) return null;
  const workerExpiry = currentWorkerNowMs + durationMs;
  const databaseExpiry = row.now_ms + durationMs;
  if (!Number.isSafeInteger(workerExpiry) || !Number.isSafeInteger(databaseExpiry)) return null;
  const expiresAtMs = Math.min(workerExpiry, databaseExpiry);
  return expiresAtMs > Math.max(currentWorkerNowMs, row.now_ms) ? expiresAtMs : null;
}
