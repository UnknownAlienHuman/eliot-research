import { GoogleCredentialError, oauthIdentifier, tokenBinding, type GoogleTokenBinding } from "@eliotr/google-drive-exchange";
import type { AccessIdentity, AccessVerifier } from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";
import { apiResult, configuredAccessVerifier, HttpRequestError, problem, type HttpDependencies } from "./http.js";
import { readStreamWithinBytes } from "@eliotr/platform-cloudflare";
import { createGoogleOAuthAdmissionForOwner, readGoogleOAuthServerConfiguration } from "./google-oauth-service.js";
import { createD1GoogleCredentialStore, readD1GoogleCredentialStatus, type GoogleCredentialStatus } from "./google-token-store.js";
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

export async function handleGoogleConnectionStatus(request: Request, env: Env, context: OwnerContext,
  identity: AccessIdentity, dependencies: HttpDependencies): Promise<Response> {
  const readiness = await readReadiness(env); if (!readiness.ready) return problem(request, 503, "SCHEMA_NOT_READY", "Required D1 migrations are not applied", true);
  originAndCsrf(request);
  const verifier = dependencies.accessVerifier ?? configuredAccessVerifier(env);
  const guard = ownerGuard({ request, identity, verifier, context });
  try {
    await guard();
    const config = readGoogleOAuthServerConfiguration(env);
    const binding = { connection_id: config.connection_id, principal_id: context.principal_ref,
      oauth_client_id: config.oauth_client_id, google_subject: config.google_subject, google_email: config.google_email };
    const first = await readD1GoogleCredentialStatus(env.CORE_DB, binding, request.signal);
    await guard();
    const second = await readD1GoogleCredentialStatus(env.CORE_DB, binding, request.signal);
    if (JSON.stringify(first) !== JSON.stringify(second)) throw new GoogleCredentialError("GOOGLE_CREDENTIAL_CHANGED");
    await guard();
    return apiResult(request, env, statusResult(config.connection_id, second));
  } catch (error) {
    if (error instanceof GoogleCredentialError) return problem(request, error.code === "GOOGLE_OAUTH_OWNER_REVOKED" ? 401 : error.code === "GOOGLE_CREDENTIAL_UNAVAILABLE" ? 503 : 409,
      error.code, "Google connection status is unavailable", error.code === "GOOGLE_CREDENTIAL_UNAVAILABLE");
    throw error;
  }
}

function statusResult(connectionId: string, status: GoogleCredentialStatus | null) {
  return { protocol: "eliotr.google-connection-status.v1", connection_id: connectionId,
    credential_generation: status?.binding.credential_generation ?? null, credential_revision: status?.revision ?? null,
    state: status?.state ?? "DISCONNECTED" } as const;
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
  const configurationJson = JSON.stringify(config);
  const receiptKey = { principal_id: context.principal_ref, operation_ref: input.operation_ref };
  type DisconnectReceipt = { readonly expected_credential_generation: string; readonly expected_credential_revision: number;
    readonly result_credential_generation: string | null; readonly result_credential_revision: number | null; readonly result_state: "REVOKED" | null };
  const readReceipt = async (): Promise<DisconnectReceipt | null> => {
    const row = await env.CORE_DB.prepare(`SELECT expected_credential_generation,expected_credential_revision,result_credential_generation,
      result_credential_revision,result_state,connection_id,configuration_json FROM google_oauth_disconnect_receipt
      WHERE principal_id=?1 AND operation_ref=?2`).bind(receiptKey.principal_id, receiptKey.operation_ref).first<Record<string, unknown>>()
      .catch(() => { throw new GoogleCredentialError("GOOGLE_CREDENTIAL_UNAVAILABLE"); });
    if (!row) return null;
    if (row.connection_id !== config.connection_id || row.configuration_json !== configurationJson
        || typeof row.expected_credential_generation !== "string" || typeof row.expected_credential_revision !== "number"
        || !Number.isSafeInteger(row.expected_credential_revision) || row.expected_credential_revision < 1
        || (row.result_credential_generation !== null && typeof row.result_credential_generation !== "string")
        || (row.result_credential_revision !== null && typeof row.result_credential_revision !== "number")
        || (row.result_state !== null && row.result_state !== "REVOKED")) throw new GoogleCredentialError("GOOGLE_CREDENTIAL_CHANGED");
    return { expected_credential_generation: row.expected_credential_generation, expected_credential_revision: row.expected_credential_revision,
      result_credential_generation: row.result_credential_generation as string | null,
      result_credential_revision: row.result_credential_revision as number | null, result_state: row.result_state as "REVOKED" | null };
  };
  const result = (receipt: DisconnectReceipt) => ({ protocol: "eliotr.google-oauth-disconnect.v1", connection_id: config.connection_id,
    credential_generation: receipt.result_credential_generation, credential_revision: receipt.result_credential_revision, state: receipt.result_state });
  let receipt: DisconnectReceipt;
  try {
    await env.CORE_DB.prepare(`INSERT OR IGNORE INTO google_oauth_disconnect_receipt
      (principal_id,operation_ref,connection_id,configuration_json,expected_credential_generation,expected_credential_revision,created_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7)`).bind(receiptKey.principal_id, receiptKey.operation_ref, config.connection_id, configurationJson,
      input.expected_generation, input.expected_revision, new Date().toISOString()).run();
    const loaded = await readReceipt();
    if (loaded === null || loaded.expected_credential_generation !== input.expected_generation || loaded.expected_credential_revision !== input.expected_revision) {
      throw new GoogleCredentialError("GOOGLE_CREDENTIAL_CHANGED");
    }
    receipt = loaded;
  } catch (error) {
    if (error instanceof GoogleCredentialError) return problem(request, error.code === "GOOGLE_CREDENTIAL_UNAVAILABLE" ? 503 : 409,
      error.code, "Google connection lifecycle state changed", error.code === "GOOGLE_CREDENTIAL_UNAVAILABLE");
    throw error;
  }
  if (receipt.result_state !== null) return apiResult(request, env, result(receipt));
  const binding: GoogleTokenBinding = tokenBinding({ connection_id: config.connection_id, principal_id: context.principal_ref,
    oauth_client_id: config.oauth_client_id, google_subject: config.google_subject, google_email: config.google_email,
    credential_generation: input.expected_generation });
  const store = createD1GoogleCredentialStore(env.CORE_DB, binding);
  try {
    const current = await store.load(request.signal);
    if (current.revision !== input.expected_revision || current.binding.credential_generation !== input.expected_generation || store.revoke === undefined) {
      if (current.revision === input.expected_revision + 1 && current.binding.credential_generation === input.expected_generation && current.state === "REVOKED") {
        const settled = await readReceipt();
        if (settled?.result_state === "REVOKED") return apiResult(request, env, result(settled));
      }
      throw new GoogleCredentialError("GOOGLE_CREDENTIAL_CHANGED");
    }
    const revoked = await store.revoke(current, request.signal);
    await env.CORE_DB.prepare(`UPDATE google_oauth_disconnect_receipt SET result_credential_generation=?3,result_credential_revision=?4,result_state='REVOKED'
      WHERE principal_id=?1 AND operation_ref=?2 AND expected_credential_generation=?5 AND expected_credential_revision=?6 AND result_state IS NULL`)
      .bind(receiptKey.principal_id, receiptKey.operation_ref, revoked.binding.credential_generation, revoked.revision,
        input.expected_generation, input.expected_revision).run();
    const settled = await readReceipt();
    if (settled?.result_state !== "REVOKED") throw new GoogleCredentialError("GOOGLE_CREDENTIAL_WRITE_UNCONFIRMED");
    receipt = settled;
    await guard();
    return apiResult(request, env, result(receipt));
  } catch (error) {
    if (error instanceof GoogleCredentialError) return problem(request, error.code === "GOOGLE_OAUTH_OWNER_REVOKED" ? 401 : 409, error.code, "Google connection lifecycle state changed", false);
    throw error;
  }
}
