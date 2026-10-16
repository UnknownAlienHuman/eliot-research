/**
 * Workers AI daily neurons usage observation endpoint.
 *
 * Queries the Cloudflare GraphQL Analytics API for actual neuron usage
 * from the aiInferenceAdaptiveGroups dataset. Returns official pricing
 * constants alongside real usage data when the Analytics API is accessible.
 *
 * Source: https://developers.cloudflare.com/workers-ai/platform/pricing/
 * Schema: account.aiInferenceAdaptiveGroups sum.totalNeurons (float64)
 * Last verified: 2026-10-15
 */

export type { AiUsageObservation } from "@eliotr/contracts";
import { AiUsageObservationSchema } from "@eliotr/contracts";
import type { z } from "zod";

const FREE_ALLOCATION_NEURONS = 10_000;
const PRICING_URL = "https://developers.cloudflare.com/workers-ai/platform/pricing/";
const ANALYTICS_API_URL = "https://api.cloudflare.com/client/v4/graphql";
const REQUEST_TIMEOUT_MS = 10_000;
const GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.com";

const GRAPHQL_QUERY = `query GetAiUsage($account: String!, $startTime: Time!, $endTime: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      aiInferenceAdaptiveGroups(
        limit: 1,
        filter: { datetime_geq: $startTime, datetime_lt: $endTime }
      ) {
        sum {
          totalNeurons
        }
      }
    }
  }
}`;

function getTodayUtcRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  return { start: start.toISOString(), end: now.toISOString() };
}

function extractAccountIdFromGatewayUrl(gatewayUrl: string): string | null {
  try {
    const url = new URL(gatewayUrl);
    if (url.origin !== GATEWAY_ORIGIN) return null;
    const match = /^\/v1\/([a-f0-9]{32})\//.exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function fetchNeuronsFromAnalytics(
  accountId: string,
  startTime: string,
  endTime: string,
  token: string,
): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(ANALYTICS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: GRAPHQL_QUERY,
        variables: { account: accountId, startTime, endTime },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("data" in payload) ||
      typeof payload.data !== "object" ||
      payload.data === null ||
      !("viewer" in payload.data)
    ) {
      return null;
    }
    if ("errors" in payload && Array.isArray(payload.errors) && payload.errors.length > 0) {
      return null;
    }
    const viewer = payload.data.viewer;
    if (
      typeof viewer !== "object" ||
      viewer === null ||
      !("accounts" in viewer) ||
      !Array.isArray(viewer.accounts) ||
      viewer.accounts.length === 0
    ) {
      return null;
    }
    const account = viewer.accounts[0];
    if (
      typeof account !== "object" ||
      account === null ||
      !("aiInferenceAdaptiveGroups" in account) ||
      !Array.isArray(account.aiInferenceAdaptiveGroups)
    ) {
      return null;
    }
    if (account.aiInferenceAdaptiveGroups.length === 0) {
      return 0;
    }
    const groups = account.aiInferenceAdaptiveGroups[0];
    if (
      typeof groups !== "object" ||
      groups === null ||
      !("sum" in groups) ||
      typeof groups.sum !== "object" ||
      groups.sum === null ||
      !("totalNeurons" in groups.sum) ||
      typeof groups.sum.totalNeurons !== "number"
    ) {
      return null;
    }
    const neurons = groups.sum.totalNeurons;
    if (!Number.isFinite(neurons) || neurons < 0) return null;
    return neurons;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export interface AiUsageDependencies {
  readonly gatewayUrl: string;
  readonly analyticsToken: string | undefined;
}

export async function createAiUsageObservation(
  deps: AiUsageDependencies,
): Promise<z.infer<typeof AiUsageObservationSchema>> {
  const { start, end } = getTodayUtcRange();
  const accountId = extractAccountIdFromGatewayUrl(deps.gatewayUrl);
  const observedAt = new Date().toISOString();

  if (accountId === null) {
    return AiUsageObservationSchema.parse({
      protocol: "eliotr.ai-usage-observation.v2",
      period_start: start,
      period_end: end,
      free_allocation_neurons: FREE_ALLOCATION_NEURONS,
      remaining_neurons: null,
      usage_neurons: null,
      observed_at: observedAt,
      provider_analytics_scope: "aiInferenceAdaptiveGroups",
      status: "unavailable",
      unavailability_reason: "Cloudflare account ID could not be derived from gateway URL",
      pricing_reference_url: PRICING_URL,
    });
  }

  if (deps.analyticsToken === undefined) {
    return AiUsageObservationSchema.parse({
      protocol: "eliotr.ai-usage-observation.v2",
      period_start: start,
      period_end: end,
      free_allocation_neurons: FREE_ALLOCATION_NEURONS,
      remaining_neurons: null,
      usage_neurons: null,
      observed_at: observedAt,
      provider_analytics_scope: "aiInferenceAdaptiveGroups",
      status: "unavailable",
      unavailability_reason: "Analytics API token is not configured",
      pricing_reference_url: PRICING_URL,
    });
  }

  const neurons = await fetchNeuronsFromAnalytics(accountId, start, end, deps.analyticsToken);

  if (neurons === null) {
    return AiUsageObservationSchema.parse({
      protocol: "eliotr.ai-usage-observation.v2",
      period_start: start,
      period_end: end,
      free_allocation_neurons: FREE_ALLOCATION_NEURONS,
      remaining_neurons: null,
      usage_neurons: null,
      observed_at: observedAt,
      provider_analytics_scope: "aiInferenceAdaptiveGroups",
      status: "unavailable",
      unavailability_reason: "Analytics API request failed or returned no data",
      pricing_reference_url: PRICING_URL,
    });
  }

  return AiUsageObservationSchema.parse({
    protocol: "eliotr.ai-usage-observation.v2",
    period_start: start,
    period_end: end,
    free_allocation_neurons: FREE_ALLOCATION_NEURONS,
    remaining_neurons: Math.max(FREE_ALLOCATION_NEURONS - neurons, 0),
    usage_neurons: neurons,
    observed_at: observedAt,
    provider_analytics_scope: "aiInferenceAdaptiveGroups",
    status: "available",
    unavailability_reason: null,
    pricing_reference_url: PRICING_URL,
  });
}
