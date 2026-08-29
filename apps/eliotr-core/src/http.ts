import { jsonResponse, ROUTES, type ApiProblem } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { readReadiness } from "./readiness.js";

function traceId(request: Request): string {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
}

function problem(request: Request, status: number, code: string, title: string, retryable: boolean): Response {
  const body: ApiProblem = {
    type: `urn:eliotr:problem:${code.toLowerCase()}`,
    title,
    status,
    code,
    trace_id: traceId(request),
    retryable,
  };
  return jsonResponse(body, { status });
}

export async function handleHttp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/healthz" || url.pathname === "/api/v1/system/health") {
    const readiness = await readReadiness(env);
    return jsonResponse(readiness, { status: readiness.ready ? 200 : 503 });
  }
  if (url.pathname === "/api/v1/system/capabilities") {
    return jsonResponse({
      protocol: "eliotr.capabilities.v1",
      deployment_generation: env.DEPLOYMENT_GENERATION,
      routes: ROUTES,
      enabled_slices: ["SCAFFOLD", "HEALTH"],
      disabled_slices: ["INGEST", "RETRIEVAL", "RESEARCH", "WIKI", "DRIVE_EXCHANGE", "ERASURE"],
      exact_evidence_resolution_required: true,
      transport_completion_is_research_completion: false,
    });
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/federation/") || url.pathname.startsWith("/oauth/")) {
    const readiness = await readReadiness(env);
    if (!readiness.ready) return problem(request, 503, "SCHEMA_NOT_READY", "Required D1 migrations are not applied", true);
    return problem(request, 501, "IMPLEMENTATION_SLICE_PENDING", "The route contract exists but its owned work packet is not implemented", false);
  }
  return env.ASSETS.fetch(request);
}
