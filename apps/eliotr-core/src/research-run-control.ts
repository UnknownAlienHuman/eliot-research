import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";
import { createResearchRunReadEnvironment } from "./research-run-read-authorization.js";
import { createProjectClientRunReadEnvironment } from "./research-client-run-read.js";
import { createResearchClientSpendEnvironment } from "./research-client-spend.js";
import {
  cancelResearchRun as cancelResearchRunCapability,
  recoverResearchRun as recoverResearchRunCapability,
  runControlStatus,
  isRecoverableStartedResearchStage,
} from "@eliotr/cloudflare-research-runtime";

function fail(code: string, status: number, retryable = false): never {
  throw new CatalogInputError(code, "Research run control could not be confirmed", status, retryable);
}

/** The validated owner/service request remains at the authenticated HTTP boundary. */
export function validateResearchRunControl(
  context: AuthenticatedRequestContext, operationId: string, body: unknown, allowService = false,
): void {
  if (context.client_class !== "owner_pwa" && (!allowService ||
      (context.client_class !== "trusted_agent" && context.client_class !== "named_api_client"))) {
    fail("RESEARCH_OWNER_REQUIRED", 403);
  }
  if (context.client_class !== "owner_pwa" && context.access?.authentication_method !== "service_token") {
    fail("RESEARCH_CONTROL_DENIED", 403);
  }
  const origin = context.request.headers.get("origin");
  const site = context.request.headers.get("sec-fetch-site");
  if ((origin !== null && origin !== new URL(context.request.url).origin) ||
      (site !== null && site !== "same-origin" && site !== "none")) fail("RESEARCH_CONTROL_ORIGIN_DENIED", 403);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(operationId)) fail("RESEARCH_INPUT_INVALID", 400);
  if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    fail("RESEARCH_INPUT_INVALID", 400);
  }
  const key = context.request.headers.get("idempotency-key");
  if (key === null || key.length < 1 || key.length > 256 || /[\u0000-\u0020\u007f]/u.test(key)) {
    fail("RESEARCH_INPUT_INVALID", 400);
  }
  if (context.access === undefined || context.access.principal_ref !== context.principal_ref ||
      context.access.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(context.access.expires_at)) || Date.parse(context.access.expires_at) <= Date.now()) {
    fail("RESEARCH_CONTROL_DENIED", 403);
  }
  if (context.request.signal.aborted) fail("RESEARCH_CONTROL_INTERRUPTED", 503, true);
}

export { runControlStatus, isRecoverableStartedResearchStage };

function environment(env: Env) {
  return {
    database: env.CORE_DB,
    workflow: env.RESEARCH_WORKFLOW,
    run_read: createResearchRunReadEnvironment(env),
    client_run_read: createProjectClientRunReadEnvironment(env),
    client_spend: createResearchClientSpendEnvironment(env),
    validate_request: validateResearchRunControl,
  };
}

export function cancelResearchRun(
  env: Env, context: AuthenticatedRequestContext, operationId: string, body: unknown,
): Promise<ResearchRunStatus> {
  return cancelResearchRunCapability(environment(env), context, operationId, body);
}

export function recoverResearchRun(
  env: Env, context: AuthenticatedRequestContext, operationId: string, body: unknown,
): Promise<ResearchRunStatus> {
  return recoverResearchRunCapability(environment(env), context, operationId, body);
}
