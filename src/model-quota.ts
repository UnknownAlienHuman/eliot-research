import type { ModelProvider } from "./models";
import type { ModelSpec } from "./models";
import { LibraryError } from "./library";
import { readBoundedText } from "./model-catalog";

export interface NativeUsage {
  neurons: number | null;
  allowanceNeurons: 10_000;
  dayStart: string;
  resetAt: string;
  error: string | null;
}

export interface NativeUsageEnvironment {
  readonly ELIOT_CF_ANALYTICS_TOKEN?: string;
  readonly ELIOT_CF_ACCOUNT_ID?: string;
}

const NATIVE_ANALYTICS_URL = "https://api.cloudflare.com/client/v4/graphql";
const NATIVE_ANALYTICS_RESPONSE_BYTES = 64 * 1024;
const NATIVE_ANALYTICS_TIMEOUT_MS = 10_000;
const NATIVE_ALLOWANCE_NEURONS = 10_000 as const;
const UTC_DAY_MS = 24 * 60 * 60 * 1000;

const NATIVE_USAGE_QUERY = [
  "query GetAiUsage($account: String!, $startTime: Time!, $endTime: Time!) {",
  "  viewer {",
  "    accounts(filter: { accountTag: $account }) {",
  "      aiInferenceAdaptiveGroups(",
  "        limit: 1,",
  "        filter: { datetime_geq: $startTime, datetime_lt: $endTime }",
  "      ) {",
  "        sum {",
  "          totalNeurons",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

function utcUsageWindow(now: Date): { dayStart: string; endTime: string; resetAt: string } {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    dayStart: new Date(start).toISOString(),
    endTime: now.toISOString(),
    resetAt: new Date(start + UTC_DAY_MS).toISOString(),
  };
}

function parseNativeUsage(payload: unknown): { neurons: number | null; error: string | null } {
  const root = isRecord(payload) ? payload : null;
  if (root === null) return { neurons: null, error: "analytics-response-invalid" };
  if (root["errors"] !== undefined && (!Array.isArray(root["errors"]) || root["errors"].length > 0))
    return { neurons: null, error: "analytics-query-failed" };
  const data = isRecord(root["data"]) ? root["data"] : null;
  const viewer = data !== null && isRecord(data["viewer"]) ? data["viewer"] : null;
  const accounts = viewer !== null && Array.isArray(viewer["accounts"]) ? viewer["accounts"] : null;
  const account = accounts?.[0];
  const groups = isRecord(account) && Array.isArray(account["aiInferenceAdaptiveGroups"])
    ? account["aiInferenceAdaptiveGroups"] : null;
  if (groups === null) return { neurons: null, error: "analytics-response-invalid" };
  if (groups.length === 0) return { neurons: 0, error: null };
  const first = groups[0];
  const sum = isRecord(first) && isRecord(first["sum"]) ? first["sum"] : null;
  const neurons = sum?.["totalNeurons"];
  if (typeof neurons !== "number" || !Number.isFinite(neurons) || neurons < 0)
    return { neurons: null, error: "analytics-response-invalid" };
  return { neurons, error: null };
}

/** Reads the current UTC day's Workers AI Neurons once; it never gates model admission. */
export async function readNativeUsage(env: NativeUsageEnvironment): Promise<NativeUsage> {
  const now = new Date();
  const window = utcUsageWindow(now);
  const result = (neurons: number | null, error: string | null): NativeUsage => ({
    neurons,
    allowanceNeurons: NATIVE_ALLOWANCE_NEURONS,
    dayStart: window.dayStart,
    resetAt: window.resetAt,
    error,
  });
  const token = env.ELIOT_CF_ANALYTICS_TOKEN?.trim();
  const accountId = env.ELIOT_CF_ACCOUNT_ID?.trim();
  if (!token) return result(null, "analytics-token-missing");
  if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) return result(null, "analytics-account-id-invalid");

  try {
    const response = await fetch(NATIVE_ANALYTICS_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        query: NATIVE_USAGE_QUERY,
        variables: { account: accountId, startTime: window.dayStart, endTime: window.endTime },
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(NATIVE_ANALYTICS_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error = response.status === 401 || response.status === 403
        ? "analytics-permission-denied" : "analytics-http-" + response.status;
      return result(null, error);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await readBoundedText(response, NATIVE_ANALYTICS_RESPONSE_BYTES));
    } catch {
      return result(null, "analytics-response-invalid");
    }
    const parsed = parseNativeUsage(payload);
    return result(parsed.neurons, parsed.error);
  } catch {
    return result(null, "analytics-unavailable");
  }
}
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

export interface ProviderQuota {
  providerId: string;
  usage: number | null;
  limit: number | null;
  error: string | null;
}

const UNKNOWN: Omit<ProviderQuota, "providerId"> = { usage: null, limit: null, error: "quota-unknown" };
const UNAVAILABLE: Omit<ProviderQuota, "providerId"> = { usage: null, limit: null, error: "quota-unavailable" };

const QUOTA_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// Official OpenRouter key shape only: { data: { usage, limit, ... } }.
// Missing or invalid numbers stay null (never 0).
function pickQuota(data: unknown): Pick<ProviderQuota, "usage" | "limit"> {
  const root = isRecord(data) ? data : null;
  const inner = root !== null && isRecord(root["data"]) ? (root["data"] as Record<string, unknown>) : null;
  if (inner === null) {
    return { usage: null, limit: null };
  }
  const usage = finiteAmount(inner["usage"]);
  const limitRaw = inner["limit"];
  const limit = limitRaw === null || limitRaw === undefined ? null : finiteAmount(limitRaw);
  return { usage, limit };
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
    return { usage: picked.usage, limit: picked.limit, error: null };
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
    out.push({ providerId: p.id, ...q });
  }
  return out;
}
