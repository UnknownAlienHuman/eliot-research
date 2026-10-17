import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { ResearchConfigurationMethodReadinessPin } from
  "@eliotr/cloudflare-research-configuration/research-configuration-readiness.js";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";
import { apiResult } from "./http-response.js";
import { requireEmptyRequestBody, singleQueryValue } from "./http-route-inputs.js";
import { readOwnerProjectResearchMethodReadiness, readOwnerProjectResearchReadiness } from
  "./research-project-configuration-composition.js";

const METHOD_READINESS_CAPABILITY = "research-methods-v1";
const METHOD_READINESS_QUERY_KEYS = new Set([
  "project_id", "capability", "configuration_project_id", "configuration_ref", "configuration_sha256", "selection_revision",
]);
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

/** Parse only the opt-in request. Absence of the capability stays on the unchanged V1 path. */
export function parseResearchMethodReadinessQuery(url: URL): {
  readonly projectId: string;
  readonly selectionPin: ResearchConfigurationMethodReadinessPin;
} | undefined {
  if (!url.searchParams.has("capability")) return undefined;
  for (const key of url.searchParams.keys()) {
    if (!METHOD_READINESS_QUERY_KEYS.has(key)) {
      throw new HttpRequestError("UNKNOWN_QUERY_PARAMETER", 400, "Research method readiness query contains an unknown parameter");
    }
  }
  const capability = singleQueryValue(url, "capability");
  if (capability !== METHOD_READINESS_CAPABILITY) {
    throw new HttpRequestError("RESEARCH_METHOD_CAPABILITY_INVALID", 400, "Research method readiness capability is invalid");
  }
  const projectId = singleQueryValue(url, "project_id");
  const configurationProjectId = singleQueryValue(url, "configuration_project_id");
  const configurationRef = singleQueryValue(url, "configuration_ref");
  const configurationSha = singleQueryValue(url, "configuration_sha256");
  const rawSelectionRevision = singleQueryValue(url, "selection_revision");
  if (projectId === undefined || !SAFE_PROJECT_ID.test(projectId) || configurationProjectId !== projectId ||
      configurationRef === undefined || !/^rpmc-[a-f0-9]{64}$/u.test(configurationRef) ||
      configurationSha === undefined || !/^[a-f0-9]{64}$/u.test(configurationSha) ||
      rawSelectionRevision === undefined || !/^[1-9][0-9]{0,6}$/u.test(rawSelectionRevision)) {
    throw new HttpRequestError("RESEARCH_METHOD_READINESS_QUERY_INVALID", 400,
      "Research method readiness requires a complete valid project selection pin for the current project");
  }
  const selectionRevision = Number(rawSelectionRevision);
  if (!Number.isSafeInteger(selectionRevision) || selectionRevision < 1 || selectionRevision > 1_000_000) {
    throw new HttpRequestError("RESEARCH_METHOD_READINESS_QUERY_INVALID", 400, "Selection revision is invalid");
  }
  return Object.freeze({ projectId, selectionPin: Object.freeze({ configuration_project_id: configurationProjectId,
    configuration_ref: configurationRef, configuration_sha256: configurationSha, selection_revision: selectionRevision }) });
}

/** Existing V1 reads remain unchanged unless the caller explicitly opts into method readiness. */
export async function handleResearchConfigurationReadiness(input: {
  readonly request: Request;
  readonly env: Env;
  readonly context: AuthenticatedRequestContext;
  readonly url: URL;
}): Promise<Response> {
  const methodReadiness = parseResearchMethodReadinessQuery(input.url);
  if (methodReadiness === undefined) {
    for (const key of input.url.searchParams.keys()) {
      if (key !== "project_id") throw new HttpRequestError("UNKNOWN_QUERY_PARAMETER", 400,
        "Research configuration query contains an unknown parameter");
    }
    return apiResult(input.request, input.env, await readOwnerProjectResearchReadiness(input.env, input.context,
      singleQueryValue(input.url, "project_id")));
  }
  await requireEmptyRequestBody(input.request, "Research method readiness does not accept a request body");
  return apiResult(input.request, input.env, await readOwnerProjectResearchMethodReadiness(input.env, input.context,
    methodReadiness.selectionPin));
}
