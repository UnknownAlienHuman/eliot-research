import { GoogleCredentialError } from "@eliotr/google-drive-exchange";
import type { AccessIdentity, AccessVerifier } from "@eliotr/cloudflare-access";
import type { Env } from "./env.js";
import {
  configuredAccessVerifier,
  HttpRequestError,
  problem,
  type HttpDependencies,
} from "./http.js";
import {
  createGoogleOAuthAdmissionForOwner,
} from "./google-oauth-service.js";
import { mapGoogleOAuthError } from "./google-oauth-begin.js";
import { readReadiness } from "./readiness.js";

const GOOGLE_ISSUER = "https://accounts.google.com";
const STATE = /^[A-Za-z0-9_-]{43}$/u;
const CALLBACK_ERROR = /^[a-z_]{1,64}$/u;
const CALLBACK_CODE = /^[\x21-\x7e]{1,4096}$/u;
const CALLBACK_SUCCESS_OPTIONAL = new Set(["scope", "authuser", "hd", "prompt"]);
const CALLBACK_ERROR_OPTIONAL = new Set(["error_description", "error_uri"]);
const CALLBACK_OPTIONAL = new Set([...CALLBACK_SUCCESS_OPTIONAL, ...CALLBACK_ERROR_OPTIONAL]);

type CallbackOutcome = "authorized" | "denied" | "expired" | "conflict" | "retry" | "rejected";

function callbackRedirect(request: Request, outcome: CallbackOutcome): Response {
  const location = new URL("/", request.url);
  location.hash = `eliotr-google-oauth=${outcome}`;
  return new Response(null, {
    status: 303,
    headers: {
      location: location.href,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function callbackInput(request: Request): { readonly state: string; readonly iss?: string; readonly code?: string; readonly error?: string } {
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  if (keys.length < 2 || keys.length > 9 || new Set(keys).size !== keys.length ||
      !keys.every((key) => key === "state" || key === "iss" || key === "code" || key === "error" || CALLBACK_OPTIONAL.has(key)) ||
      !keys.includes("state") || (keys.includes("code") === keys.includes("error"))) {
    throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
  }
  const one = (key: string): string => {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || values[0] === undefined || values[0].length === 0 || /[\u0000-\u001f\u007f]/u.test(values[0])) {
      throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
    }
    return values[0];
  };
  const state = one("state");
  const iss = keys.includes("iss") ? one("iss") : undefined;
  if (!STATE.test(state) || (iss !== undefined && iss !== GOOGLE_ISSUER)) {
    throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
  }
  for (const key of CALLBACK_OPTIONAL) {
    if (!keys.includes(key)) continue;
    const value = one(key);
    if (key === "scope" && value.length > 4096) throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
    if (key === "authuser" && !/^(?:0|[1-9][0-9]{0,2})$/u.test(value)) throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
    if (key === "hd" && (value.length > 255 || !/^[A-Za-z0-9.-]+$/u.test(value))) throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
    if (key === "prompt" && !/^(?:none|consent|select_account)$/u.test(value)) throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
    if (key === "error_description" && value.length > 2048) throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
    if (key === "error_uri") {
      if (value.length > 2048) throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
      try { const uri = new URL(value); if (uri.protocol !== "https:" || uri.username || uri.password || uri.hash) throw new Error(); }
      catch { throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid"); }
    }
  }
  if (keys.includes("code")) {
    if ([...CALLBACK_ERROR_OPTIONAL].some((key) => keys.includes(key))) throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
    const code = one("code");
    if (!CALLBACK_CODE.test(code)) throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
    return { state, ...(iss === undefined ? {} : { iss }), code };
  }
  if ([...CALLBACK_SUCCESS_OPTIONAL].some((key) => keys.includes(key))) throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
  const error = one("error");
  if (!CALLBACK_ERROR.test(error)) throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
  return { state, ...(iss === undefined ? {} : { iss }), error };
}

function callbackError(request: Request, error: GoogleCredentialError): Response {
  switch (error.code) {
    case "GOOGLE_OAUTH_CONSENT_DENIED": return callbackRedirect(request, "denied");
    case "GOOGLE_OAUTH_INTENT_EXPIRED": return callbackRedirect(request, "expired");
    case "GOOGLE_OAUTH_ALREADY_ATTEMPTED":
    case "GOOGLE_OAUTH_INTENT_CONSUMED":
    case "GOOGLE_OAUTH_INTENT_UNAVAILABLE":
    case "GOOGLE_OAUTH_CLAIM_CHANGED":
    case "GOOGLE_OAUTH_INTENT_INVALID": return callbackRedirect(request, "conflict");
    case "GOOGLE_OAUTH_IDENTITY_REJECTED":
    case "GOOGLE_OAUTH_CODE_REJECTED": return callbackRedirect(request, "rejected");
    case "GOOGLE_OAUTH_CANCELLED":
    case "GOOGLE_OAUTH_OUTCOME_UNKNOWN":
    case "GOOGLE_OAUTH_ADMISSION_UNCONFIRMED":
    case "GOOGLE_OAUTH_FAILED": return callbackRedirect(request, "retry");
    default: return mapGoogleOAuthError(request, error);
  }
}

/**
 * Owner-only Google OAuth callback. The callback query is normalized before
 * any D1/provider work; all trust inputs remain server-owned or Access-bound.
 * The browser receives only a fixed outcome fragment, never provider data.
 */
export async function handleGoogleOAuthCallback(
  request: Request,
  env: Env,
  context: { readonly principal_ref: string; readonly credential_generation: string },
  identity: AccessIdentity,
  dependencies: HttpDependencies,
): Promise<Response> {
  const input = callbackInput(request);
  const readiness = await readReadiness(env);
  if (!readiness.ready) return problem(request, 503, "SCHEMA_NOT_READY", "Required D1 migrations are not applied", true);
  let admission;
  try {
    const verifier: AccessVerifier = dependencies.accessVerifier ?? configuredAccessVerifier(env);
    // Auto mode lets a durable reconnect intent restore its expected CAS fence
    // after a restart while leaving initial admission no-overwrite semantics intact.
    admission = await createGoogleOAuthAdmissionForOwner({ env, request, context, identity, verifier, reconnect: "auto" });
  } catch (error) {
    if (error instanceof GoogleCredentialError) {
      if (error.code.startsWith("GOOGLE_OAUTH_NOT_CONFIGURED")) return problem(request, 503, "GOOGLE_OAUTH_NOT_CONFIGURED", "Google OAuth token configuration is missing or invalid", true);
      if (error.code === "GOOGLE_OAUTH_OWNER_INVALID") return problem(request, 403, "GOOGLE_OAUTH_OWNER_INVALID", "Authenticated owner identity cannot finish OAuth", false);
    }
    throw error;
  }
  const redirect = new URL(admission.configuration.redirect_uri);
  const callbackUrl = new URL(request.url);
  callbackUrl.search = "";
  callbackUrl.hash = "";
  if (redirect.origin !== callbackUrl.origin || redirect.pathname !== callbackUrl.pathname || redirect.href !== callbackUrl.href) {
    throw new HttpRequestError("GOOGLE_OAUTH_NOT_CONFIGURED", 503, "Google OAuth callback is not configured for this origin", true);
  }
  try {
    await admission.service.finish({ ...input, iss: input.iss ?? GOOGLE_ISSUER }, request.signal);
    return callbackRedirect(request, "authorized");
  } catch (error) {
    if (error instanceof GoogleCredentialError) {
      if (error.code === "GOOGLE_OAUTH_OWNER_REVOKED") return problem(request, 401, error.code, "Owner session is no longer current", false,
        { "www-authenticate": "Bearer realm=\"Cloudflare Access\"" });
      return callbackError(request, error);
    }
    throw error;
  }
}
