import {
  AccessVerificationError,
  createCloudflareAccessVerifier,
  type AccessIdentity,
  type AccessVerifier,
} from "@eliotr/cloudflare-access";
import type { AuthenticatedRequestContext, RouteDefinition } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { OWNER_E2E_AUDIENCE, OWNER_E2E_ISSUER, parseServicePrincipals, resolveOwnerE2ETestFetch } from "./env.js";
import { HttpRequestError } from "./http-errors.js";
interface AccessVerifierCache {
  readonly key: string;
  readonly verifier: AccessVerifier;
}
const traceIds = new WeakMap<Request, string>();
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
let accessVerifierCache: AccessVerifierCache | undefined;
export function traceId(request: Request): string {
  const existing = traceIds.get(request);
  if (existing !== undefined) return existing;
  const candidate = request.headers.get("cf-ray");
  const value = candidate !== null && SAFE_TRACE_ID.test(candidate)
    ? candidate
    : crypto.randomUUID();
  traceIds.set(request, value);
  return value;
}
export function configuredAccessVerifier(env: Env): AccessVerifier {
  if (env.ACCESS_TEAM_DOMAIN === undefined || env.ACCESS_AUDIENCE === undefined) {
    throw new AccessVerificationError(
      "ACCESS_CONFIG_INVALID",
      "Cloudflare Access runtime configuration is missing",
      true,
    );
  }
  const servicePrincipals = parseServicePrincipals(env.ACCESS_SERVICE_PRINCIPALS);
  const testJwks = env.ACCESS_TEST_JWKS_URL;
  if (testJwks !== undefined && testJwks !== "" && env.ENVIRONMENT !== "development") {
    throw new AccessVerificationError("ACCESS_CONFIG_INVALID",
      "Access test JWKS override is development-only; staging/production must use the real network verifier", true);
  }
  const key = JSON.stringify([env.ENVIRONMENT, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUDIENCE, servicePrincipals, testJwks ?? ""]);
  if (accessVerifierCache?.key === key) return accessVerifierCache.verifier;
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUDIENCE;
  const expectedCerts = `${teamDomain.endsWith("/") ? teamDomain.slice(0, -1) : teamDomain}/cdn-cgi/access/certs`;
  const testFetch = teamDomain === OWNER_E2E_ISSUER && audience === OWNER_E2E_AUDIENCE
    ? resolveOwnerE2ETestFetch(env, expectedCerts)
    : (testJwks !== undefined && testJwks !== "" ? (() => {
      throw new AccessVerificationError("ACCESS_CONFIG_INVALID",
        "Access test JWKS override outside the exact owner-e2e profile is denied", true);
    })() as never : undefined);
  const verifier = createCloudflareAccessVerifier({
    team_domain: teamDomain,
    audience,
    allowed_service_principal_common_names: servicePrincipals,
  }, testFetch === undefined ? {} : { fetch: testFetch });
  accessVerifierCache = { key, verifier };
  return verifier;
}
export function authorize(
  request: Request,
  route: RouteDefinition,
  identity: AccessIdentity,
): AuthenticatedRequestContext {
  if (route.auth === "public") throw new Error("public route entered protected authorization");
  const service = identity.authentication_method === "service_token";
  if ((route.auth === "owner" && service) || (route.auth === "service" && !service)) {
    throw new HttpRequestError(
      "PRINCIPAL_CLASS_DENIED",
      403,
      "authenticated principal class is not allowed for this operation",
    );
  }
  return {
    request,
    principal_ref: identity.principal_ref,
    client_class: service
      ? route.auth === "service" ? "federation_client" : "trusted_agent"
      : "owner_pwa",
    credential_generation: identity.credential_generation,
    trace_id: traceId(request),
    access: {
      principal_ref: identity.principal_ref,
      credential_generation: identity.credential_generation,
      expires_at: identity.expires_at,
      authentication_method: identity.authentication_method,
      ...(identity.issuer === undefined ? {} : { issuer: identity.issuer }),
    },
  };
}
