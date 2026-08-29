import type { ModelCallInput, ModelCallReceipt, ModelRoutePort } from "@eliotr/research";

export interface RouteFingerprint {
  readonly route_ref: string;
  readonly provider: string;
  readonly exact_model_id: string;
  readonly route_version: string;
  readonly prompt_generation: string;
  readonly schema_generation: string;
  readonly parameters_digest: string;
  readonly pricing_snapshot_ref: string;
}

export interface ModelGatewayAdapter extends ModelRoutePort {
  execute(input: ModelCallInput): Promise<ModelCallReceipt>;
  resolveFingerprint(routeRef: string): Promise<RouteFingerprint>;
}

export const APPLICATION_MODEL_ROUTES = [
  "dynamic/eliotr-economy",
  "dynamic/eliotr-balanced",
  "dynamic/eliotr-strong",
  "dynamic/eliotr-frontier",
  "dynamic/eliotr-audit-writer",
  "dynamic/eliotr-audit-verifier",
  "dynamic/eliotr-vision",
  "dynamic/eliotr-extract",
  "dynamic/eliotr-report-section",
  "dynamic/eliotr-report-integrator",
] as const;

export const GATEWAY_SEPARATION = {
  retrieval: { cache: false, rate_limit: false, model_substitution: false },
  reasoning: { byok: true, dynamic_routes: true, spend_limits: true, fallback: true, dlp: true },
} as const;
