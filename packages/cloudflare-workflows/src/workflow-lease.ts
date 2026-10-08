/** Bound a newly issued workflow lease by both local and D1 wall clocks. */
export async function readD1BoundedWorkflowLeaseExpiry(
  database: D1Database,
  durationMs: number,
  workerNowMs?: number,
): Promise<number | null> {
  if ((workerNowMs !== undefined && !Number.isSafeInteger(workerNowMs)) ||
      !Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 600_000) {
    return null;
  }
  let row: { readonly now_ms: number } | null;
  try {
    row = await database.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms")
      .first<{ readonly now_ms: number }>();
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
