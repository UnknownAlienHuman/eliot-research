import { LibraryError } from "./library";
import type { ModelSpec } from "./models";

export function estimateCost(model: ModelSpec, input: number, cached: number, output: number): number {
  if (![input, cached, output].every((n) => Number.isSafeInteger(n) && n >= 0) || cached > input) throw new RangeError("Invalid model usage.");
  return Math.ceil(((input - cached) * model.inputMicrousdPerMillion + cached * model.cachedMicrousdPerMillion + output * model.outputMicrousdPerMillion) / 1_000_000);
}
export async function monthlyUsage(env: Env) {
  const now = new Date(), start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const row = await env.DB.prepare(`SELECT monthly_model_budget_microusd AS budget,
    (SELECT COALESCE(SUM(estimated_cost_microusd),0) FROM chat_turn WHERE created_at>=?) AS used FROM settings WHERE id=1`)
    .bind(start).first<{ budget: number; used: number }>();
  if (!row) throw new LibraryError("unavailable", "Model settings are unavailable.", 503);
  return { monthlyBudgetMicrousd: row.budget, monthlyUsedMicrousd: row.used, monthStart: start };
}
export async function admitTurn(env: Env, chatId: string, turnId: string, model: ModelSpec) {
  const bound = estimateCost(model, model.contextTokens, 0, model.maxOutputTokens);
  const { monthStart } = await monthlyUsage(env);
  // The owning turn holds the conservative reservation. The conditional update is atomic across chats.
  const result = await env.DB.prepare(`UPDATE chat_turn SET estimated_cost_microusd=?,pricing_checked_on=?
    WHERE chat_id=? AND turn_id=? AND state='started' AND estimated_cost_microusd IS NULL
    AND ?+(SELECT COALESCE(SUM(estimated_cost_microusd),0) FROM chat_turn WHERE created_at>=?)
      <=(SELECT monthly_model_budget_microusd FROM settings WHERE id=1)`)
    .bind(bound, model.checkedOn, chatId, turnId, bound, monthStart).run();
  if (!result.meta.changes) throw new LibraryError("budget", "The monthly budget cannot admit this model's upper bound. Choose a cheaper model or change the budget in Settings.", 409);
  return bound;
}
