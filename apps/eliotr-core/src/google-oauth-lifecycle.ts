import { GoogleCredentialError, oauthIdentifier, tokenBinding, type GoogleTokenBinding } from "@eliotr/google-drive-exchange";
import type { AccessIdentity, AccessVerifier } from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";
import { apiResult, configuredAccessVerifier, HttpRequestError, problem, type HttpDependencies } from "./http.js";
import { readStreamWithinBytes } from "@eliotr/platform-cloudflare";
import { createGoogleOAuthAdmissionForOwner, readGoogleOAuthServerConfiguration } from "./google-oauth-service.js";
import { createD1GoogleCredentialStore } from "./google-token-store.js";
import { readReadiness } from "./readiness.js";

type OwnerContext = { readonly principal_ref: string; readonly credential_generation: string };

function bodyError(): never { throw new HttpRequestError("GOOGLE_OAUTH_INPUT_INVALID", 400, "Google OAuth lifecycle body is invalid"); }
async function lifecycleBody(request: Request, maxBytes: number): Promise<{ readonly operation_ref: string; readonly expected_generation: string; readonly expected_revision: number }> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !request.body) return bodyError();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readStreamWithinBytes(request.body, { label: "http.request.google-oauth-lifecycle", max_bytes: maxBytes }))); }
  catch { return bodyError(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return bodyError();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || typeof input.operation_ref !== "string" || typeof input.expected_credential_generation !== "string"
      || !Number.isSafeInteger(input.expected_credential_revision) || (input.expected_credential_revision as number) < 1) return bodyError();
  try {
    return { operation_ref: oauthIdentifier(input.operation_ref), expected_generation: oauthIdentifier(input.expected_credential_generation),
      expected_revision: input.expected_credential_revision as number };
  } catch { return bodyError(); }
}

function ownerGuard(input: { request: Request; identity: AccessIdentity; verifier: AccessVerifier; context: OwnerContext }) {
  return async () => {
    let current: AccessIdentity;
    try { current = await input.verifier.verify(input.request); } catch { throw new GoogleCredentialError("GOOGLE_OAUTH_OWNER_REVOKED"); }
    if (current.principal_ref !== input.identity.principal_ref || current.credential_generation !== input.identity.credential_generation
        || current.authentication_method !== input.identity.authentication_method) throw new GoogleCredentialError("GOOGLE_OAUTH_OWNER_REVOKED");
  };
}

function originAndCsrf(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin === null || origin !== new URL(request.url).origin) throw new HttpRequestError("GOOGLE_OAUTH_ORIGIN_FORBIDDEN", 403, "Cross-origin OAuth lifecycle request is forbidden");
  if (request.headers.get("x-eliotr-csrf") !== "1") throw new HttpRequestError("GOOGLE_OAUTH_CSRF_REQUIRED", 400, "OAuth lifecycle request requires the CSRF header");
}

export async function handleGoogleOAuthReconnectBegin(request: Request, env: Env, context: OwnerContext,
  identity: AccessIdentity, dependencies: HttpDependencies): Promise<Response> {
  const readiness = await readReadiness(env); if (!readiness.ready) return problem(request, 503, "SCHEMA_NOT_READY", "Required D1 migrations are not applied", true);
  originAndCsrf(request);
  const input = await lifecycleBody(request, 1536);
  const verifier = dependencies.accessVerifier ?? configuredAccessVerifier(env);
  const guard = ownerGuard({ request, identity, verifier, context }); await guard();
  try {
    const admission = await createGoogleOAuthAdmissionForOwner({ env, request, context, identity, verifier,
      reconnect: { expected_generation: input.expected_generation, expected_revision: input.expected_revision },
      fetchImpl: () => Promise.reject(new GoogleCredentialError("GOOGLE_OAUTH_PROVIDER_CALL_FORBIDDEN")) });
    const result = await admission.service.begin(input.operation_ref, request.signal); await guard();
    return apiResult(request, env, result);
  } catch (error) {
    if (error instanceof GoogleCredentialError) return problem(request, error.code === "GOOGLE_OAUTH_OWNER_REVOKED" ? 401 : 409, error.code, "Google OAuth reconnect cannot be started", error.code === "GOOGLE_OAUTH_STORE_UNAVAILABLE");
    throw error;
  }
}

export async function handleGoogleConnectionDisconnect(request: Request, env: Env, context: OwnerContext,
  identity: AccessIdentity, dependencies: HttpDependencies): Promise<Response> {
  const readiness = await readReadiness(env); if (!readiness.ready) return problem(request, 503, "SCHEMA_NOT_READY", "Required D1 migrations are not applied", true);
  originAndCsrf(request);
  const input = await lifecycleBody(request, 1536);
  const verifier = dependencies.accessVerifier ?? configuredAccessVerifier(env);
  const guard = ownerGuard({ request, identity, verifier, context }); await guard();
  const config = readGoogleOAuthServerConfiguration(env);
  const binding: GoogleTokenBinding = tokenBinding({ connection_id: config.connection_id, principal_id: context.principal_ref,
    oauth_client_id: config.oauth_client_id, google_subject: config.google_subject, google_email: config.google_email,
    credential_generation: input.expected_generation });
  const store = createD1GoogleCredentialStore(env.CORE_DB, binding);
  try {
    const current = await store.load(request.signal);
    if (current.revision !== input.expected_revision || store.revoke === undefined) throw new GoogleCredentialError("GOOGLE_CREDENTIAL_CHANGED");
    const revoked = await store.revoke(current, request.signal); await guard();
    return apiResult(request, env, { protocol: "eliotr.google-oauth-disconnect.v1", connection_id: binding.connection_id,
      credential_generation: revoked.binding.credential_generation, credential_revision: revoked.revision, state: revoked.state });
  } catch (error) {
    if (error instanceof GoogleCredentialError) return problem(request, error.code === "GOOGLE_OAUTH_OWNER_REVOKED" ? 401 : 409, error.code, "Google connection lifecycle state changed", false);
    throw error;
  }
}
