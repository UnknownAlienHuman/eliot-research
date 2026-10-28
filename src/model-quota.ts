import type { ModelProvider } from "./models";
import type { ModelSpec } from "./models";
import { LibraryError } from "./library";
import { readBoundedText } from "./model-catalog";

/** Native admission follows the saved owner choice; included stays paused until upstream enforcement exists. */
export async function assertProviderAllowance(env: Env, model: ModelSpec): Promise<void> {
  if (model.route.startsWith("workers-ai:") === false) return;
  let mode: unknown;
  try {
    const row = await env.DB.prepare("SELECT native_usage_mode AS mode FROM settings WHERE id=1").first<{ mode: unknown }>();
    mode = row?.mode ?? null;
  } catch {
    mode = null;
  }
  if (mode === "standard") return;
  throw new LibraryError(
    "budget",
    "Workers AI included usage is paused: the exact included cap cannot be enforced or verified on this account. No model call was started. Choose another provider or standard billing in Settings.",
    409,
  );
}

// Provider quota readout. Owner-only POST refresh is the only caller; it pays 0 model calls.
// GET/list/catalog paths never query quota. No registry, cache, polling, price parser, or monthly cap here.
// Pinned spike proof: eval/out/provider-quota/result.json (2026-10-28) - native GET
// gateways/eliotr-reasoning/openrouter/v1/key via AI.fetch, HTTP 200, usage 0, limit null,
// resetAt null, unit null, no Authorization, one attempt, no retry, no model call.

export interface ProviderQuota {
  providerId: string;
  usage: number | null;
  limit: number | null;
  resetAt: string | null;
  unit: "USD" | null;
  error: string | null;
}

const UNKNOWN: Omit<ProviderQuota, "providerId"> = { usage: null, limit: null, resetAt: null, unit: null, error: "quota-unknown" };
const UNAVAILABLE: Omit<ProviderQuota, "providerId"> = { usage: null, limit: null, resetAt: null, unit: null, error: "quota-unavailable" };

const QUOTA_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// Official OpenRouter key shape only: { data: { usage, limit, ... } }.
// Missing or invalid numbers stay null (never 0). resetAt stays null: no official published
// date field verified (never convert a reset interval into a date). unit stays null:
// no official unit proved.
function pickQuota(data: unknown): Pick<ProviderQuota, "usage" | "limit" | "resetAt"> {
  const root = isRecord(data) ? data : null;
  const inner = root !== null && isRecord(root["data"]) ? (root["data"] as Record<string, unknown>) : null;
  if (inner === null) {
    return { usage: null, limit: null, resetAt: null };
  }
  const usage = finiteAmount(inner["usage"]);
  const limitRaw = inner["limit"];
  const limit = limitRaw === null || limitRaw === undefined ? null : finiteAmount(limitRaw);
  return { usage, limit, resetAt: null };
}

async function readOpenRouterQuota(gatewayId: string, ai: Pick<Fetcher, "fetch">): Promise<Omit<ProviderQuota, "providerId">> {
  const target = "https://workers-binding.ai/ai-gateway/gateways/" + encodeURIComponent(gatewayId) + "/openrouter/v1/key";
  try {
    const resp = await ai.fetch(target, {
      method: "GET",
      headers: {
        accept: "application/json",
        "cf-aig-no-wholesale": "true",
        "cf-aig-max-attempts": "1",
        "cf-aig-skip-cache": "true",
        "cf-aig-collect-log": "false"
      },
      signal: AbortSignal.timeout(15000)
    });
    if (resp.ok === false) {
      return UNAVAILABLE;
    }
    let data: unknown = null;
    try {
      data = JSON.parse(await readBoundedText(resp, QUOTA_BYTES));
    } catch {
      return UNKNOWN;
    }
    const picked = pickQuota(data);
    if (picked.usage === null && picked.limit === null) {
      const hasData = isRecord(data) && isRecord((data as Record<string, unknown>)["data"]);
      if (hasData === false) {
        return UNKNOWN;
      }
    }
    return { usage: picked.usage, limit: picked.limit, resetAt: null, unit: null, error: null };
  } catch {
    return UNAVAILABLE;
  }
}

function isOpenRouterRoute(p: ModelProvider): boolean {
  return p.type === "openai-compatible" && p.enabled === true && p.gatewaySlug === "openrouter" && p.gatewayPath === "v1";
}

export async function readProviderQuotas(
  env: Partial<Pick<Env, "AI">>,
  providers: ModelProvider[],
  connection: { gatewayId: string | null }
): Promise<ProviderQuota[]> {
  const out: ProviderQuota[] = [];
  for (const p of providers) {
    if (p === null || p === undefined || isOpenRouterRoute(p) === false) {
      const id = p !== null && p !== undefined ? p.id : "unknown";
      out.push({ providerId: id, ...UNKNOWN });
      continue;
    }
    if (!connection || !connection.gatewayId) {
      out.push({ providerId: p.id, ...UNKNOWN });
      continue;
    }
    const binding = env.AI;
    if (!env || binding === undefined || binding === null) {
      out.push({ providerId: p.id, ...UNAVAILABLE });
      continue;
    }
    const q = await readOpenRouterQuota(connection.gatewayId, binding as unknown as Pick<Fetcher, "fetch">);
    out.push({ providerId: p.id, usage: q.usage, limit: q.limit, resetAt: q.resetAt, unit: q.unit, error: q.error });
  }
  return out;
}
