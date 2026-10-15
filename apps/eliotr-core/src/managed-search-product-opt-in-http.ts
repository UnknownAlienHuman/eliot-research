import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { HttpRequestError } from "./http-errors.js";
import { apiResult, requireNoQuery } from "./http-response.js";
import { requireProviderKeyMutationSecurity } from "./http-request-auth.js";
import { requireEmptyRequestBody } from "./http-route-inputs.js";
import type { Env } from "./env.js";
import {
  createManagedSearchProductOptInService,
  mapManagedTargetAssignmentError,
  type ManagedSearchProductOptInSnapshotV2,
} from "./managed-target-assignment.js";
import { ManagedTargetAssignmentError } from "@eliotr/cloudflare-projection";

export const MANAGED_SEARCH_PRODUCT_OPT_IN_PROTOCOL =
  "eliotr.managed-search-product-optin.v2" as const;
export const MANAGED_SEARCH_PRODUCT_OPT_IN_HTTP_MAX_BYTES = 2_048;
const MAX_EXPECTED_HEAD_REVISION = 999_999;

function invalid(message: string): never {
  throw new HttpRequestError("MANAGED_SEARCH_PRODUCT_OPT_IN_INPUT_INVALID", 400, message);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("Managed-search product decision must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
    invalid("Managed-search product decision has missing or unsupported fields");
  }
}

function expectedHeadRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) ||
      value < 0 || value > MAX_EXPECTED_HEAD_REVISION) {
    invalid("Expected managed-search head revision is invalid");
  }
  return value;
}

function parseDecision(value: unknown): {
  readonly expected_head_revision: number;
  readonly decision: "ENABLED" | "DISABLED";
} {
  const body = record(value);
  if (body.protocol !== MANAGED_SEARCH_PRODUCT_OPT_IN_PROTOCOL) {
    invalid("Managed-search product decision protocol is unsupported");
  }
  if (body.decision === "ENABLED") {
    exactKeys(body, ["protocol", "expected_head_revision", "decision", "product_alias"]);
    if (body.product_alias !== "primary") {
      invalid("Only the reviewed primary managed-search product is available");
    }
  } else if (body.decision === "DISABLED") {
    exactKeys(body, ["protocol", "expected_head_revision", "decision"]);
  } else {
    invalid("Managed-search product decision must be ENABLED or DISABLED");
  }
  return Object.freeze({
    expected_head_revision: expectedHeadRevision(body.expected_head_revision),
    decision: body.decision as "ENABLED" | "DISABLED",
  });
}

function requestLimit(routeLimit: number): number {
  if (!Number.isSafeInteger(routeLimit) || routeLimit < 1) {
    throw new HttpRequestError("MANAGED_SEARCH_PRODUCT_OPT_IN_REQUEST_INVALID", 400,
      "Managed-search product request limit is invalid");
  }
  return Math.min(routeLimit, MANAGED_SEARCH_PRODUCT_OPT_IN_HTTP_MAX_BYTES);
}

/** Strict owner-only product decision over the existing Core assignment head. */
export async function handleManagedSearchProductOptInHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  projectId: string,
  routeLimit: number,
): Promise<Response> {
  const url = new URL(request.url);
  requireNoQuery(url);
  const service = createManagedSearchProductOptInService(env, context, projectId);
  try {
    if (request.method === "GET") {
      await requireEmptyRequestBody(request,
        "Managed-search product read does not accept a request body");
      const result: ManagedSearchProductOptInSnapshotV2 = await service.read();
      return apiResult(request, env, result);
    }
    if (request.method !== "PUT") {
      throw new HttpRequestError("METHOD_NOT_ALLOWED", 405,
        "Method is not supported for managed-search product decisions");
    }
    requireProviderKeyMutationSecurity(
      request,
      url,
      new HttpRequestError("MANAGED_SEARCH_PRODUCT_OPT_IN_CSRF_DENIED", 403,
        "Managed-search product changes require a same-origin owner request"),
      new HttpRequestError("MANAGED_SEARCH_PRODUCT_OPT_IN_INPUT_INVALID", 415,
        "Managed-search product changes require application/json"),
    );
    const input = parseDecision(await readJsonBodyWithinBytes(request, requestLimit(routeLimit)));
    const result = await service.decide(input);
    return apiResult(request, env, result);
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    if (error instanceof ManagedTargetAssignmentError) mapManagedTargetAssignmentError(error);
    mapManagedTargetAssignmentError(error);
  }
}
