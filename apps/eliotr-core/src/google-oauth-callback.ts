import {
  GOOGLE_OAUTH_ISSUER,
  GoogleCredentialError,
  parseGoogleOAuthCallbackTransportInput,
} from "@eliotr/google-drive-exchange";
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
  const input = parseGoogleOAuthCallbackTransportInput({
    request_url: request.url,
    fail: (code, status, message) => { throw new HttpRequestError(code, status, message); },
  });
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
    await admission.service.finish({ ...input, iss: input.iss ?? GOOGLE_OAUTH_ISSUER }, request.signal);
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
