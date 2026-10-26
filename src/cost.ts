import { LibraryError } from "./library";
import type { ModelSpec } from "./models";

const monthlyEstimate = `(SELECT COALESCE(SUM(estimated_cost_microusd),0) FROM chat_turn WHERE created_at>=?)
  +(SELECT COALESCE(SUM(distill_estimated_cost_microusd),0) FROM source_revision WHERE distill_started_at>=?)`;

export function estimateCost(model: ModelSpec, input: number, cached: number, output: number): number {
  if (![input, cached, output].every((n) => Number.isSafeInteger(n) && n >= 0) || cached > input) throw new RangeError("Invalid model usage.");
  return Math.ceil(((input - cached) * model.inputMicrousdPerMillion + cached * model.cachedMicrousdPerMillion + output * model.outputMicrousdPerMillion) / 1_000_000);
}
export async function monthlyUsage(env: Env) {
  const now = new Date(), start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const row = await env.DB.prepare(`SELECT monthly_model_budget_microusd AS budget,
    ${monthlyEstimate} AS used FROM settings WHERE id=1`)
    .bind(start, start).first<{ budget: number; used: number }>();
  if (!row) throw new LibraryError("unavailable", "Model settings are unavailable.", 503);
  return { monthlyBudgetMicrousd: row.budget, monthlyUsedMicrousd: row.used, monthStart: start };
}
export async function admitTurn(env: Env, chatId: string, turnId: string, model: ModelSpec) {
  const bound = estimateCost(model, model.contextTokens, 0, model.maxOutputTokens);
  const { monthStart } = await monthlyUsage(env);
  // The owning turn holds the conservative reservation. The conditional update is atomic across chats.
  const result = await env.DB.prepare(`UPDATE chat_turn SET estimated_cost_microusd=?,pricing_checked_on=?
    WHERE chat_id=? AND turn_id=? AND state='started' AND estimated_cost_microusd IS NULL
    AND ?+(${monthlyEstimate})
      <=(SELECT monthly_model_budget_microusd FROM settings WHERE id=1)`)
    .bind(bound, model.checkedOn, chatId, turnId, bound, monthStart, monthStart).run();
  if (!result.meta.changes) throw new LibraryError("budget", "The monthly budget cannot admit this model's upper bound. Choose a cheaper model or change the budget in Settings.", 409);
  return bound;
}

export async function admitDistill(env: Env, revisionId: string, model: ModelSpec): Promise<boolean> {
  const bound = 2 * estimateCost(model, model.contextTokens, 0, model.maxOutputTokens);
  const { monthStart } = await monthlyUsage(env);
  const admitted = await env.DB.prepare(`UPDATE source_revision SET distill_state='running',distill_model=?,
    distill_started_at=?,distill_estimated_cost_microusd=?,distill_pricing_checked_on=?,distill_error=NULL
    WHERE id=? AND distill_state='queued' AND distill_calls=0
      AND (SELECT COUNT(*) FROM source_revision WHERE distill_state='running')<2
      AND ?+(${monthlyEstimate})<=(SELECT monthly_model_budget_microusd FROM settings WHERE id=1)`)
    .bind(model.route, Date.now(), bound, model.checkedOn, revisionId, bound, monthStart, monthStart).run();
  if (admitted.meta.changes) return true;
  await env.DB.prepare(`UPDATE source_revision SET distill_state='paused',distill_error='Monthly model budget cannot admit two bounded calls. Resume explicitly after changing the budget or month.'
    WHERE id=? AND distill_state='queued' AND ?+(${monthlyEstimate})>(SELECT monthly_model_budget_microusd FROM settings WHERE id=1)`)
    .bind(revisionId, bound, monthStart, monthStart).run();
  return false;
}
export async function failUndispatchedDistill(env: Env, revisionId: string, error: string): Promise<boolean> {
  // Release a stuck distill slot only when no paid call was dispatched: one
  // atomic UPDATE guarded by state='running' AND calls=0. When paid dispatch
  // already won (calls>=1) or the row moved on, changes=0 and the helper
  // returns false, preserving the reservation and state. No R2 report is
  // written before this CAS, so a zero-usage failure can never race a real
  // paid call's report.
  const now = Date.now();
  const released = await env.DB.prepare(`UPDATE source_revision SET distill_state='failed',distill_error=?,
    distill_estimated_cost_microusd=0,distill_input_tokens=0,distill_cached_tokens=0,distill_output_tokens=0,
    distill_ms=?-distill_started_at
    WHERE id=? AND distill_state='running' AND distill_calls=0`)
    .bind(error, now, revisionId).run();
  return released.meta.changes === 1;
}
