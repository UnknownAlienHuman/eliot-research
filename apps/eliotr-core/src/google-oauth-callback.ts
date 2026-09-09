import { GoogleCredentialError, oauthIdentifier } from "@eliotr/google-drive-exchange";
import type { AccessIdentity, AccessVerifier } from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";
import {
  configuredAccessVerifier,
  HttpRequestError,
  problem,
  type HttpDependencies,
} from "./http.js";
import {
  createD1GoogleOAuthAdmission,
  importGoogleOAuthServerKey,
  readGoogleOAuthClientSecret,
  readGoogleOAuthServerConfiguration,
} from "./google-oauth-service.js";
import { mapGoogleOAuthError } from "./google-oauth-begin.js";
import { readReadiness } from "./readiness.js";

const GOOGLE_ISSUER = "https://accounts.google.com";
const STATE = /^[A-Za-z0-9_-]{43}$/u;
const CALLBACK_ERROR = /^[a-z_]{1,64}$/u;
const CALLBACK_CODE = /^[\x21-\x7e]{1,4096}$/u;
const CALLBACK_OPTIONAL = new Set(["scope", "authuser", "hd", "prompt", "error_description", "error_uri"]);

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

function callbackInput(request: Request): { readonly state: string; readonly iss: string; readonly code?: string; readonly error?: string } {
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  if (keys.length < 3 || keys.length > 9 || new Set(keys).size !== keys.length ||
      !keys.every((key) => key === "state" || key === "iss" || key === "code" || key === "error" || CALLBACK_OPTIONAL.has(key)) ||
      !keys.includes("state") || !keys.includes("iss") || (keys.includes("code") === keys.includes("error"))) {
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
  const iss = one("iss");
  if (!STATE.test(state) || iss !== GOOGLE_ISSUER) {
    throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
  }
  if (keys.includes("code")) {
    const code = one("code");
    if (!CALLBACK_CODE.test(code)) throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
    for (const key of ["scope", "authuser", "hd", "prompt"]) {
      if (keys.includes(key)) {
        const value = one(key);
        if (value.length > 1024) throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
      }
    }
    return { state, iss, code };
  }
  const error = one("error");
  if (!CALLBACK_ERROR.test(error)) throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
  for (const key of ["error_description", "error_uri"]) {
    if (keys.includes(key)) {
      const value = one(key);
      if (value.length > 2048) throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
      if (key === "error_uri") {
        try { const uri = new URL(value); if (uri.protocol !== "https:" || uri.username || uri.password || uri.hash) throw new Error(); }
        catch { throw new HttpRequestError("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid"); }
      }
    }
  }
  return { state, iss, error };
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
  const readiness = await readReadiness(env);
  if (!readiness.ready) return problem(request, 503, "SCHEMA_NOT_READY", "Required D1 migrations are not applied", true);
  const input = callbackInput(request);
  let configuration;
  try {
    configuration = readGoogleOAuthServerConfiguration(env);
    const redirect = new URL(configuration.redirect_uri);
    const callbackUrl = new URL(request.url);
    callbackUrl.search = "";
    callbackUrl.hash = "";
    if (redirect.origin !== callbackUrl.origin || redirect.pathname !== callbackUrl.pathname || redirect.href !== callbackUrl.href) throw new Error();
  } catch (error) {
    if (error instanceof GoogleCredentialError) return problem(request, 503, "GOOGLE_OAUTH_NOT_CONFIGURED", "Google OAuth operator configuration is missing or invalid", true);
    throw new HttpRequestError("GOOGLE_OAUTH_NOT_CONFIGURED", 503, "Google OAuth callback is not configured for this origin", true);
  }
  let owner: { readonly principal_id: string; readonly session_generation: string };
  try {
    owner = { principal_id: oauthIdentifier(context.principal_ref), session_generation: oauthIdentifier(context.credential_generation) };
  } catch (error) {
    if (error instanceof GoogleCredentialError) return problem(request, 403, "GOOGLE_OAUTH_OWNER_INVALID", "Authenticated owner identity cannot finish OAuth", false);
    throw error;
  }
  let key: CryptoKey;
  let keyVersion: number;
  try { ({ key, version: keyVersion } = await importGoogleOAuthServerKey(env)); }
  catch (error) {
    if (error instanceof GoogleCredentialError) return problem(request, 503, "GOOGLE_OAUTH_NOT_CONFIGURED", "Google OAuth token key is missing or invalid", true);
    throw error;
  }
  let clientSecret: string;
  try { clientSecret = readGoogleOAuthClientSecret(env); }
  catch (error) {
    if (error instanceof GoogleCredentialError) return problem(request, 503, "GOOGLE_OAUTH_NOT_CONFIGURED", "Google OAuth client secret is missing or invalid", true);
    throw error;
  }
  const verifier: AccessVerifier = dependencies.accessVerifier ?? configuredAccessVerifier(env);
  const assertOwnerCurrent = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    let current: AccessIdentity;
    try { current = await verifier.verify(request); }
    catch { throw new GoogleCredentialError("GOOGLE_OAUTH_OWNER_REVOKED"); }
    if (current.principal_ref !== identity.principal_ref || current.credential_generation !== identity.credential_generation ||
        current.authentication_method !== identity.authentication_method) throw new GoogleCredentialError("GOOGLE_OAUTH_OWNER_REVOKED");
    signal.throwIfAborted();
  };
  const service = createD1GoogleOAuthAdmission({
    database: env.CORE_DB,
    configuration,
    owner,
    keys: new Map([[keyVersion, key]]),
    activeKeyVersion: keyVersion,
    clientSecret,
    deadlineEpochMs: Date.now() + 60000,
    assertOwnerCurrent,
  });
  try {
    await service.finish(input, request.signal);
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
