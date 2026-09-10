import type { BeginGoogleOAuthResult } from "@eliotr/interfaces";
import {
  GoogleCredentialError,
  oauthIdentifier,
} from "@eliotr/google-drive-exchange";
import {
  readStreamWithinBytes,
} from "@eliotr/platform-cloudflare";
import type { AccessIdentity } from "@eliotr/cloudflare-access";
import {
  createGoogleOAuthAdmissionForOwner,
} from "./google-oauth-service.js";
import type { Env } from "./env.js";
import {
  apiResult,
  configuredAccessVerifier,
  HttpRequestError,
  type HttpDependencies,
  problem,
} from "./http.js";
import { readReadiness } from "./readiness.js";

/**
 * G1 strict owner-only Google OAuth begin. Owner/session/currentness come only
 * from verified Cloudflare Access; configuration/redirect/deployment/key
 * identity are server-owned. Enforces same-origin + CSRF, accepts exactly one
 * body field (`operation_ref`), and performs no provider/token call and no
 * credential/exchange/folder/sheet/cursor/grant/source/result creation.
 */
export async function handleGoogleOAuthBegin(
  request: Request,
  env: Env,
  context: { readonly principal_ref: string; readonly credential_generation: string },
  identity: AccessIdentity,
  dependencies: HttpDependencies,
): Promise<Response> {
  const readiness = await readReadiness(env);
  if (!readiness.ready) {
    return problem(request, 503, "SCHEMA_NOT_READY", "Required D1 migrations are not applied", true);
  }
  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin === null || origin === "") {
    throw new HttpRequestError("GOOGLE_OAUTH_ORIGIN_REQUIRED", 400, "Same-origin OAuth begin requires an Origin header");
  }
  if (origin !== expectedOrigin) {
    throw new HttpRequestError("GOOGLE_OAUTH_ORIGIN_FORBIDDEN", 403, "Cross-origin OAuth begin is forbidden");
  }
  const referer = request.headers.get("referer");
  if (referer !== null && referer !== expectedOrigin && !referer.startsWith(`${expectedOrigin}/`)) {
    throw new HttpRequestError("GOOGLE_OAUTH_ORIGIN_FORBIDDEN", 403, "Cross-origin OAuth begin is forbidden");
  }
  if (request.headers.get("x-eliotr-csrf") !== "1") {
    throw new HttpRequestError("GOOGLE_OAUTH_CSRF_REQUIRED", 400, "OAuth begin requires the CSRF header");
  }
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json" || !request.body) {
    throw new HttpRequestError("GOOGLE_OAUTH_INPUT_INVALID", 400, "OAuth begin requires a JSON body");
  }
  const raw = await readStreamWithinBytes(request.body, { label: "http.request.google-oauth-begin", max_bytes: 1024 });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new HttpRequestError("GOOGLE_OAUTH_INPUT_INVALID", 400, "OAuth begin body is not valid UTF-8 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 ||
      !Object.hasOwn(value, "operation_ref")) {
    throw new HttpRequestError("GOOGLE_OAUTH_INPUT_INVALID", 400, "OAuth begin accepts only operation_ref");
  }
  let operationRef: string;
  try {
    operationRef = oauthIdentifier((value as Record<string, unknown>).operation_ref);
  } catch (error) {
    if (error instanceof GoogleCredentialError) {
      throw new HttpRequestError("GOOGLE_OAUTH_INPUT_INVALID", 400, "OAuth begin operation_ref is invalid");
    }
    throw error;
  }
  let admission;
  try {
    const verifier = dependencies.accessVerifier ?? configuredAccessVerifier(env);
    admission = await createGoogleOAuthAdmissionForOwner({
      env, request, context, identity, verifier,
      // Begin performs no provider/token call; fail closed if one is ever attempted.
      fetchImpl: () => Promise.reject(new GoogleCredentialError("GOOGLE_OAUTH_PROVIDER_CALL_FORBIDDEN")),
    });
  } catch (error) {
    if (error instanceof GoogleCredentialError) {
      if (error.code.startsWith("GOOGLE_OAUTH_NOT_CONFIGURED")) {
        throw new HttpRequestError("GOOGLE_OAUTH_NOT_CONFIGURED", 503, "Google OAuth operator configuration is missing or invalid", true);
      }
      if (error.code === "GOOGLE_OAUTH_OWNER_INVALID") {
        throw new HttpRequestError("GOOGLE_OAUTH_OWNER_INVALID", 403, "Authenticated owner identity cannot hold an OAuth intent");
      }
    }
    throw error;
  }
  if (new URL(admission.configuration.redirect_uri).origin !== expectedOrigin) {
    throw new HttpRequestError("GOOGLE_OAUTH_NOT_CONFIGURED", 503, "Google OAuth redirect is not configured for this origin", true);
  }
  let result: BeginGoogleOAuthResult;
  try {
    result = await admission.service.begin(operationRef, request.signal);
  } catch (error) {
    if (error instanceof GoogleCredentialError) return mapGoogleOAuthError(request, error);
    throw error;
  }
  if (result.protocol !== "eliotr.google-oauth-start.v1" || Object.keys(result).length !== 4) {
    throw new HttpRequestError("GOOGLE_OAUTH_BEGIN_UNCONFIRMED", 503, "OAuth begin settlement is uncertain", true);
  }
  return apiResult(request, env, result);
}

export function mapGoogleOAuthError(request: Request, error: GoogleCredentialError): Response {
  switch (error.code) {
    case "GOOGLE_OAUTH_OWNER_REVOKED":
      return problem(request, 401, error.code, "Owner session is no longer current", false,
        { "www-authenticate": "Bearer realm=\"Cloudflare Access\"" });
    case "GOOGLE_OAUTH_INPUT_INVALID":
    case "GOOGLE_OAUTH_CALLBACK_INVALID":
      return problem(request, 400, error.code, "OAuth begin input is invalid", false);
    case "GOOGLE_OAUTH_NOT_CONFIGURED":
      return problem(request, 503, error.code, "Google OAuth operator configuration is missing or invalid", true);
    case "GOOGLE_OAUTH_INTENT_EXPIRED":
      return problem(request, 410, error.code, "OAuth intent expired; start a new authorization", false);
    case "GOOGLE_OAUTH_INTENT_CONSUMED":
    case "GOOGLE_OAUTH_INTENT_UNAVAILABLE":
    case "GOOGLE_OAUTH_ALREADY_ATTEMPTED":
    case "GOOGLE_OAUTH_CLAIM_CHANGED":
    case "GOOGLE_OAUTH_INTENT_INVALID":
      return problem(request, 409, error.code, "OAuth intent conflicts with durable state", false);
    case "GOOGLE_OAUTH_STORE_UNAVAILABLE":
    case "GOOGLE_OAUTH_OUTCOME_UNKNOWN":
    case "GOOGLE_OAUTH_ADMISSION_UNCONFIRMED":
    case "GOOGLE_OAUTH_FAILED":
    case "GOOGLE_OAUTH_CANCELLED":
      return problem(request, 503, error.code, "OAuth begin settlement is uncertain; retry the same operation", true);
    default:
      return problem(request, 503, "GOOGLE_OAUTH_BEGIN_UNCONFIRMED", "OAuth begin settlement is uncertain", true);
  }
}
