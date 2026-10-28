import { LibraryError } from "./library";
import { assertProviderAllowance } from "./model-quota";
import type { ModelSpec } from "./models";
import { modelTokenLimit } from "./models";

// Native paid-effect admission: per-call token bounds plus provider allowance.
//
// Cloudflare native policy (platform facts checked 2026-10-28):
// the free allowance is 10,000 neurons/day resetting at 00:00 UTC;
// paid usage beyond the free allowance is billed per the official pricing
// (updated 2026-10-20). Whether the owner hard cap or the standard tier
// applies is still pending clarification. This module performs NO
// neuron<->token conversion: neuron accounting lives with the provider, and
// unknown allowance is never treated as zero. Token bounds here are
// request-shape limits only (usable context + output), enforced before
// dispatch. Provider allowance is owned by src/model-quota.ts.
//
// Historical currency columns (chat_turn.estimated_cost_microusd and its
// pricing snapshot, source_revision.distill_estimated_cost_microusd and its
// pricing snapshot, and the monthly budget setting) are legacy records only.
// This module neither reads nor writes them; recorded USD values stay exactly
// as stored and are never converted, reset, or used for new estimates.

export interface DayUsageSummary {
  dayStart: number;
  dayEnd: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  unknownUsages: number;
}

// Sum each known token count for jobs started in the current UTC day. Rows
// missing input or output are also counted as unknownUsages, never as known
// zero usage. A missing cached count does not hide known input/output counts.
export async function usageSummary(env: Env): Promise<DayUsageSummary> {
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  interface UsageRow {
    inputTokens: number | null;
    cachedTokens: number | null;
    outputTokens: number | null;
    unknownUsages: number | null;
  }
  const chat = await env.DB.prepare(
    "SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens," +
    " COALESCE(SUM(cached_tokens), 0) AS cachedTokens," +
    " COALESCE(SUM(output_tokens), 0) AS outputTokens," +
    " COALESCE(SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unknownUsages" +
    " FROM chat_turn WHERE created_at >= ? AND created_at < ?"
  ).bind(dayStart, dayEnd).first<UsageRow>();
  const distill = await env.DB.prepare(
    "SELECT COALESCE(SUM(distill_input_tokens), 0) AS inputTokens," +
    " COALESCE(SUM(distill_cached_tokens), 0) AS cachedTokens," +
    " COALESCE(SUM(distill_output_tokens), 0) AS outputTokens," +
    " COALESCE(SUM(CASE WHEN distill_input_tokens IS NULL OR distill_output_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unknownUsages" +
    " FROM source_revision WHERE distill_started_at >= ? AND distill_started_at < ?"
  ).bind(dayStart, dayEnd).first<UsageRow>();
  return {
    dayStart,
    dayEnd,
    inputTokens: (chat?.inputTokens ?? 0) + (distill?.inputTokens ?? 0),
    outputTokens: (chat?.outputTokens ?? 0) + (distill?.outputTokens ?? 0),
    cachedTokens: (chat?.cachedTokens ?? 0) + (distill?.cachedTokens ?? 0),
    unknownUsages: (chat?.unknownUsages ?? 0) + (distill?.unknownUsages ?? 0),
  };
}

// Admit one chat turn: reserve the model's full context+output token bound on
// the owning turn row. Provider allowance is checked before the reservation;
// its failure throws a safe owner-readable error and starts no call. The
// conditional update is atomic: exactly one writer can claim a
// started/unreserved turn. There is no monthly or dollar gate.
export async function admitTurn(env: Env, chatId: string, turnId: string, model: ModelSpec): Promise<number> {
  const bound = modelTokenLimit(model);
  await assertProviderAllowance(env, model);
  const result = await env.DB.prepare(
    "UPDATE chat_turn SET token_limit = ? WHERE chat_id = ? AND turn_id = ? AND state = 'started' AND token_limit IS NULL"
  ).bind(bound, chatId, turnId).run();
  if (!result.meta.changes)
    throw new LibraryError("conflict", "This answer cannot start right now. Retry starts a new turn; it will not continue automatically.", 409);
  return bound;
}

// Admit one explicitly requested distill revision: reserve twice the model's
// context+output bound (two bounded calls) on the owning revision row. Only an
// explicitly queued, undispatched row is eligible, and at most two revisions
// run at once. Provider allowance is checked first; its failure parks the row
// as paused with a safe error before any call. Unusable model metadata parks
// the row the same way. A full concurrency window leaves the row queued and
// returns false without pausing it. There is no monthly or dollar gate.
export async function admitDistill(env: Env, revisionId: string, model: ModelSpec): Promise<boolean> {
  let bound: number;
  try {
    bound = 2 * modelTokenLimit(model);
    if (!Number.isSafeInteger(bound)) throw new LibraryError("unavailable", "This model has no usable input/output limits.", 503);
  } catch (err) {
    await pauseDistill(env, revisionId, err instanceof Error ? err.message : "This model has no usable input/output limits.");
    return false;
  }
  try {
    await assertProviderAllowance(env, model);
  } catch (err) {
    await pauseDistill(env, revisionId, err instanceof Error ? err.message : "Provider allowance is unavailable. No model call was started.");
    return false;
  }
  const admitted = await env.DB.prepare(
    "UPDATE source_revision SET distill_state = 'running', distill_model = ?, distill_started_at = ?, distill_token_limit = ?, distill_error = NULL" +
    " WHERE id = ? AND distill_state = 'queued' AND distill_calls = 0" +
    " AND (SELECT COUNT(*) FROM source_revision WHERE distill_state = 'running') < 2"
  ).bind(model.route, Date.now(), bound, revisionId).run();
  return admitted.meta.changes === 1;
}

async function pauseDistill(env: Env, revisionId: string, error: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE source_revision SET distill_state = 'paused', distill_error = ? WHERE id = ? AND distill_state = 'queued'"
  ).bind(error, revisionId).run();
}

// Release a stuck distill slot only when no paid call was dispatched: one
// atomic UPDATE guarded by state='running' AND calls=0. When paid dispatch
// already won (calls>=1) or the row moved on, changes=0 and this returns
// false, preserving the reservation and token limit. Zero-usage failure sets
// the new token bound to 0 with zeroed token counts and never touches the
// legacy recorded cost column. No R2 report is written before this CAS, so a
// zero-usage failure cannot race a real paid call's report.
export async function failUndispatchedDistill(env: Env, revisionId: string, error: string): Promise<boolean> {
  const now = Date.now();
  const released = await env.DB.prepare(
    "UPDATE source_revision SET distill_state = 'failed', distill_error = ?, distill_token_limit = 0," +
    " distill_input_tokens = 0, distill_cached_tokens = 0, distill_output_tokens = 0," +
    " distill_ms = ? - distill_started_at" +
    " WHERE id = ? AND distill_state = 'running' AND distill_calls = 0"
  ).bind(error, now, revisionId).run();
  return released.meta.changes === 1;
}
