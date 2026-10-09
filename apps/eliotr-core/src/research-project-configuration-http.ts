import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { RESEARCH_PROJECT_MODEL_CONFIGURATION_MAX_BYTES } from "@eliotr/cloudflare-research";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { apiResult, HttpRequestError } from "./http.js";
import type { Env } from "./env.js";
import type { ResearchProjectModelConfigurationService } from "./research-project-configuration.js";
import { mapResearchProjectModelConfigurationError as mapError } from "./research-project-configuration-composition.js";

export const RESEARCH_PROJECT_MODEL_CONFIGURATION_HTTP_MAX_BYTES =
  RESEARCH_PROJECT_MODEL_CONFIGURATION_MAX_BYTES;

const CONFIGURATION_REF = /^rpmc-[a-f0-9]{64}$/u;
const PAGE_CURSOR_MAX_LENGTH = 2_048;

function invalid(message: string): never {
  throw new HttpRequestError("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, message);
}

function requireOnlyQuery(url: URL, allowed: ReadonlySet<string>): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      invalid("Project model configuration query is invalid");
    }
  }
}

function positiveInteger(value: string | null, fallback: number, maximum: number, label: string): number {
  if (value === null) return fallback;
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    invalid(`${label} is invalid`);
  }
  return Number(value);
}

function parseSelectionBody(value: unknown): { expected_revision: number | null; configuration_ref: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("Project model selection body is invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || keys.some((key) => key !== "expected_revision" && key !== "select_configuration_ref")) {
    invalid("Project model selection body has missing or unsupported fields");
  }
  const expected = record.expected_revision;
  if (expected !== null && (!Number.isSafeInteger(expected) || (expected as number) < 1 || (expected as number) >= 1_000_000)) {
    invalid("Expected project model selection revision is invalid");
  }
  const ref = record.select_configuration_ref;
  if (typeof ref !== "string" || !CONFIGURATION_REF.test(ref)) invalid("Saved configuration reference is invalid");
  return { expected_revision: expected as number | null, configuration_ref: ref };
}

function parseImportBody(value: unknown): { expected_revision: number | null; configuration: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("Project model import body is invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || keys.some((key) => key !== "expected_revision" && key !== "configuration")) {
    invalid("Project model import body has missing or unsupported fields");
  }
  const expected = record.expected_revision;
  if (expected !== null && (!Number.isSafeInteger(expected) || (expected as number) < 1 || (expected as number) >= 1_000_000)) {
    invalid("Expected project model selection revision is invalid");
  }
  if (typeof record.configuration !== "object" || record.configuration === null || Array.isArray(record.configuration)) {
    invalid("Imported project model configuration must be an exact approved bundle");
  }
  return { expected_revision: expected as number | null, configuration: record.configuration };
}

/** GET saved qualified revisions; PUT may only select an immutable saved ref. */
export async function handleResearchProjectModelConfiguration(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  projectId: string,
  service: ResearchProjectModelConfigurationService,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET") {
      requireOnlyQuery(url, new Set(["limit", "after"]));
      const limit = positiveInteger(url.searchParams.get("limit"), 50, 50, "Saved configuration page limit");
      const after = url.searchParams.get("after");
      if (after !== null && (after.length === 0 || after.length > PAGE_CURSOR_MAX_LENGTH ||
          /[\u0000-\u001f\u007f]/u.test(after))) invalid("Saved configuration cursor is invalid");
      const result = await service.readPage(context, projectId, {
        limit,
        ...(after === null ? {} : { after }),
      });
      return apiResult(request, env, result);
    }
    if (request.method === "PUT") {
      requireOnlyQuery(url, new Set());
      const body = parseSelectionBody(await readJsonBodyWithinBytes(request, RESEARCH_PROJECT_MODEL_CONFIGURATION_HTTP_MAX_BYTES));
      const result = await service.selectExisting(context, projectId, body);
      return apiResult(request, env, result);
    }
    throw new HttpRequestError("METHOD_NOT_ALLOWED", 405, "Method is not supported for project model configuration");
  } catch (error) {
    mapError(error);
  }
}

/** Import an already qualified immutable bundle. This path validates the exact
 * semantic/runtime bundle and LIVE candidate/proof tuples before D1 writes. */
export async function handleResearchProjectModelConfigurationImport(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  projectId: string,
  service: ResearchProjectModelConfigurationService,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method !== "POST") {
      throw new HttpRequestError("METHOD_NOT_ALLOWED", 405, "Method is not supported for project model configuration imports");
    }
    requireOnlyQuery(url, new Set());
    const body = parseImportBody(await readJsonBodyWithinBytes(request, RESEARCH_PROJECT_MODEL_CONFIGURATION_HTTP_MAX_BYTES));
    const result = await service.importQualifiedConfiguration(context, projectId, body);
    return apiResult(request, env, result);
  } catch (error) {
    mapError(error);
  }
}
