import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  MANAGED_TARGET_ASSIGNMENT_PROTOCOL,
  ManagedTargetAssignmentError,
  type ManagedTargetIdentity,
} from "@eliotr/cloudflare-projection";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { HttpRequestError } from "./http-errors.js";
import { apiResult, requireNoQuery } from "./http-response.js";
import { requireProviderKeyMutationSecurity } from "./http-request-auth.js";
import { requireEmptyRequestBody } from "./http-route-inputs.js";
import type { Env } from "./env.js";
import {
  createManagedTargetAssignmentService,
  mapManagedTargetAssignmentError,
} from "./managed-target-assignment.js";
import { handleManagedSearchProductOptInHttp } from "./managed-search-product-opt-in-http.js";

export const MANAGED_TARGET_ASSIGNMENT_HTTP_MAX_BYTES = 2_048;
const MAX_EXPECTED_EVENT_REVISION = 999_999;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function invalid(message: string): never {
  throw new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_INPUT_INVALID", 400, message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
    invalid(`${label} has missing or unsupported fields`);
  }
}

function expectedRevision(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) ||
      value < minimum || value > MAX_EXPECTED_EVENT_REVISION) {
    invalid("Expected assignment revision is invalid");
  }
  return value;
}

function readAssignmentRequest(value: unknown): {
  readonly expected_event_revision: number;
  readonly target: ManagedTargetIdentity;
} {
  const body = record(value, "Assignment request");
  exactKeys(body, ["protocol", "expected_event_revision", "target"], "Assignment request");
  if (body.protocol !== MANAGED_TARGET_ASSIGNMENT_PROTOCOL) {
    invalid("Assignment protocol is unsupported");
  }
  const target = record(body.target, "Target identity");
  exactKeys(target, [
    "namespace",
    "managed_instance_id",
    "managed_generation",
    "target_profile_identity_sha256",
  ], "Target identity");
  for (const field of ["namespace", "managed_instance_id", "managed_generation"] as const) {
    if (typeof target[field] !== "string" || !IDENTIFIER.test(target[field])) {
      invalid(`Target ${field} is invalid`);
    }
  }
  if (typeof target.target_profile_identity_sha256 !== "string" ||
      !SHA256.test(target.target_profile_identity_sha256)) {
    invalid("Target profile identity digest is invalid");
  }
  return Object.freeze({
    expected_event_revision: expectedRevision(body.expected_event_revision, 0),
    target: Object.freeze({
      namespace: target.namespace as string,
      managed_instance_id: target.managed_instance_id as string,
      managed_generation: target.managed_generation as string,
      target_profile_identity_sha256: target.target_profile_identity_sha256,
    }),
  });
}

function readRetirementRequest(value: unknown): { readonly expected_event_revision: number } {
  const body = record(value, "Retirement request");
  exactKeys(body, ["protocol", "expected_event_revision"], "Retirement request");
  if (body.protocol !== MANAGED_TARGET_ASSIGNMENT_PROTOCOL) {
    invalid("Assignment protocol is unsupported");
  }
  return Object.freeze({
    expected_event_revision: expectedRevision(body.expected_event_revision, 1),
  });
}

function requestLimit(routeLimit: number): number {
  if (!Number.isSafeInteger(routeLimit) || routeLimit < 1) {
    throw new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_REQUEST_INVALID", 400,
      "Managed target assignment request limit is invalid");
  }
  return Math.min(routeLimit, MANAGED_TARGET_ASSIGNMENT_HTTP_MAX_BYTES);
}

/** Strict owner-only read, assign, and retire surface over the Core 0141 event head. */
export async function handleManagedTargetAssignmentHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  projectId: string,
  routeLimit: number,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/managed-search")) {
    return handleManagedSearchProductOptInHttp(request, env, context, projectId, routeLimit);
  }
  const service = createManagedTargetAssignmentService(env, context, projectId);
  try {
    if (request.method === "GET") {
      requireNoQuery(url);
      await requireEmptyRequestBody(request,
        "Managed target assignment read does not accept a request body");
      return apiResult(request, env, await service.read());
    }

    if (request.method !== "PUT" && request.method !== "POST") {
      throw new HttpRequestError("METHOD_NOT_ALLOWED", 405,
        "Method is not supported for managed target assignment");
    }
    if (url.search !== "") {
      invalid("Managed target assignment mutation does not accept query parameters");
    }
    requireProviderKeyMutationSecurity(
      request,
      url,
      new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_CSRF_DENIED", 403,
        "Managed target assignment requires a same-origin owner request"),
      new HttpRequestError("MANAGED_TARGET_ASSIGNMENT_INPUT_INVALID", 415,
        "Managed target assignment requires application/json"),
    );
    const body = await readJsonBodyWithinBytes(request, requestLimit(routeLimit));
    if (request.method === "PUT") {
      const input = readAssignmentRequest(body);
      const event = await service.assign(input.expected_event_revision, input.target);
      return apiResult(request, env, {
        protocol: MANAGED_TARGET_ASSIGNMENT_PROTOCOL,
        event,
      });
    }
    const input = readRetirementRequest(body);
    const event = await service.retire(input.expected_event_revision);
    return apiResult(request, env, {
      protocol: MANAGED_TARGET_ASSIGNMENT_PROTOCOL,
      event,
    });
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    if (error instanceof ManagedTargetAssignmentError) {
      mapManagedTargetAssignmentError(error);
    }
    mapManagedTargetAssignmentError(error);
  }
}
