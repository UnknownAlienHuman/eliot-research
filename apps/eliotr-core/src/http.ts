import { OrientationError, ScopeServiceError, readOrientationRequest } from "@eliotr/cloudflare-navigation";
import { NavigationError } from "@eliotr/retrieval";
import { EvidenceRuntimeError } from "@eliotr/cloudflare-evidence";
import type {
  ApiProblem,
  ApplicationLifecycle,
  AuthenticatedRequestContext,
  CatalogRequest,
  RouteDefinition,
} from "@eliotr/interfaces";
import { ROUTES } from "@eliotr/interfaces";
import {
  AccessVerificationError,
  createCloudflareAccessVerifier,
  IngestAuthorityError,
  IngestStorageError,
  RUNTIME_LIMITS,
  RuntimeLimitError,
  serializeJsonWithinBytes,
  type AccessIdentity,
  type AccessVerifier,
} from "@eliotr/platform-cloudflare";
import {
  CapabilityUnavailableError,
  CatalogInputError,
  createApplication,
  type CompositionRootInput,
} from "./composition-root.js";
import type { Env } from "./env.js";
import {
  EvidenceHttpInputError,
  parseEvidenceHandleRef,
  parseEvidenceOpenRange,
  parseVerifyEvidenceRequest,
} from "./evidence-http.js";
import {
  dispatchIngestOperation,
  IngestHttpInputError,
} from "./ingest-http.js";
import { IngestServiceError } from "./ingest-service.js";
import { readReadiness } from "./readiness.js";

export interface HttpDependencies {
  readonly accessVerifier?: AccessVerifier;
  readonly applicationFactory?: (input: CompositionRootInput) => ApplicationLifecycle;
}

interface RouteMatch {
  readonly route: RouteDefinition;
  readonly params: Readonly<Record<string, string>>;
}

interface AccessVerifierCache {
  readonly key: string;
  readonly verifier: AccessVerifier;
}

class HttpRequestError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly retryable: boolean;

  public constructor(code: string, status: number, message: string, retryable = false) {
    super(message);
    this.name = "HttpRequestError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const traceIds = new WeakMap<Request, string>();
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_QUERY_VALUE_BYTES = 2 * 1024;
let accessVerifierCache: AccessVerifierCache | undefined;

function traceId(request: Request): string {
  const existing = traceIds.get(request);
  if (existing !== undefined) return existing;
  const candidate = request.headers.get("cf-ray");
  const value = candidate !== null && SAFE_TRACE_ID.test(candidate)
    ? candidate
    : crypto.randomUUID();
  traceIds.set(request, value);
  return value;
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const serialized = serializeJsonWithinBytes(
    "http.response",
    body,
    RUNTIME_LIMITS.semantic_api_response_bytes,
  );
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(serialized, { status, headers: responseHeaders });
}

function problem(
  request: Request,
  status: number,
  code: string,
  title: string,
  retryable: boolean,
  headers?: HeadersInit,
): Response {
  const body: ApiProblem = {
    type: `urn:eliotr:problem:${code.toLowerCase()}`,
    title,
    status,
    code,
    trace_id: traceId(request),
    retryable,
  };
  return jsonResponse(body, status, headers);
}

function apiResult(request: Request, env: Env, data: unknown, status = 200): Response {
  return jsonResponse({
    data,
    trace_id: traceId(request),
    deployment_generation: env.DEPLOYMENT_GENERATION,
  }, status);
}

function matchPattern(pattern: string, pathname: string): Readonly<Record<string, string>> | null {
  if (pathname.length > 1 && (pathname.endsWith("/") || pathname.includes("//"))) return null;
  const expected = pattern.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const expectedSegment = expected[index];
    const actualSegment = actual[index];
    if (expectedSegment === undefined || actualSegment === undefined) return null;
    if (!expectedSegment.startsWith(":")) {
      if (expectedSegment !== actualSegment) return null;
      continue;
    }
    let decoded: string;
    try { decoded = decodeURIComponent(actualSegment); }
    catch { return null; }
    if (
      decoded.length === 0 ||
      decoded.includes("/") ||
      new TextEncoder().encode(decoded).byteLength > MAX_QUERY_VALUE_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(decoded)
    ) return null;
    params[expectedSegment.slice(1)] = decoded;
  }
  return params;
}

function resolveRoute(request: Request, pathname: string): {
  readonly match?: RouteMatch;
  readonly allowedMethods: readonly string[];
} {
  const pathMatches = ROUTES.flatMap((route) => {
    const params = matchPattern(route.path, pathname);
    return params === null ? [] : [{ route, params }];
  });
  const match = pathMatches.find(({ route }) => route.method === request.method);
  if (match !== undefined) return { match, allowedMethods: [] };
  return {
    allowedMethods: [...new Set(pathMatches.map(({ route }) => route.method))].sort(),
  };
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/") ||
    pathname.startsWith("/federation/") ||
    pathname.startsWith("/oauth/");
}

function parseServicePrincipals(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length > 64 || new Set(values).size !== values.length) {
    throw new AccessVerificationError(
      "ACCESS_CONFIG_INVALID",
      "ACCESS_SERVICE_PRINCIPALS must contain at most 64 unique values",
      true,
    );
  }
  return values;
}

function configuredAccessVerifier(env: Env): AccessVerifier {
  if (env.ACCESS_TEAM_DOMAIN === undefined || env.ACCESS_AUDIENCE === undefined) {
    throw new AccessVerificationError(
      "ACCESS_CONFIG_INVALID",
      "Cloudflare Access runtime configuration is missing",
      true,
    );
  }
  const servicePrincipals = parseServicePrincipals(env.ACCESS_SERVICE_PRINCIPALS);
  const key = JSON.stringify([env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUDIENCE, servicePrincipals]);
  if (accessVerifierCache?.key === key) return accessVerifierCache.verifier;
  const verifier = createCloudflareAccessVerifier({
    team_domain: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUDIENCE,
    allowed_service_principal_common_names: servicePrincipals,
  });
  accessVerifierCache = { key, verifier };
  return verifier;
}

function authorize(
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
  };
}

function validateContentLength(request: Request, route: RouteDefinition): void {
  const raw = request.headers.get("content-length");
  if (raw === null) return;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw new HttpRequestError("INVALID_CONTENT_LENGTH", 400, "Content-Length is invalid");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new HttpRequestError("INVALID_CONTENT_LENGTH", 400, "Content-Length is unsafe");
  }
  if (value > route.maximum_request_bytes) {
    throw new HttpRequestError("REQUEST_BODY_TOO_LARGE", 413, "request body exceeds the route limit");
  }
}

function requireNoQuery(url: URL): void {
  if ([...url.searchParams.keys()].length > 0) {
    throw new HttpRequestError(
      "UNKNOWN_QUERY_PARAMETER",
      400,
      "this route does not accept query parameters",
    );
  }
}

function singleQueryValue(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) {
    throw new HttpRequestError("QUERY_PARAMETER_DUPLICATED", 400, `${key} may appear only once`);
  }
  const value = values[0];
  if (value === undefined || value === "") return undefined;
  if (new TextEncoder().encode(value).byteLength > MAX_QUERY_VALUE_BYTES) {
    throw new HttpRequestError("QUERY_PARAMETER_TOO_LARGE", 400, `${key} exceeds its byte limit`);
  }
  return value;
}

function parseCatalogRequest(url: URL): CatalogRequest {
  const allowed = new Set(["project_id", "cursor", "limit"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new HttpRequestError("UNKNOWN_QUERY_PARAMETER", 400, "catalog query contains an unknown parameter");
    }
  }
  const projectId = singleQueryValue(url, "project_id");
  const cursor = singleQueryValue(url, "cursor");
  const rawLimit = singleQueryValue(url, "limit");
  if (rawLimit !== undefined && !/^[1-9][0-9]{0,2}$/u.test(rawLimit)) {
    throw new HttpRequestError("CATALOG_LIMIT_INVALID", 400, "catalog limit must be an integer in [1, 100]");
  }
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpRequestError("CATALOG_LIMIT_INVALID", 400, "catalog limit must be an integer in [1, 100]");
  }
  return {
    limit,
    ...(projectId === undefined ? {} : { project_id: projectId }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

async function requireApplicationReady(
  request: Request,
  application: ApplicationLifecycle,
): Promise<Response | null> {
  const readiness = await application.readiness();
  if (readiness.ready) return null;
  return problem(
    request,
    503,
    "SCHEMA_NOT_READY",
    "Required D1 migrations are not applied",
    true,
  );
}

async function dispatch(
  request: Request,
  env: Env,
  application: ApplicationLifecycle,
  context: AuthenticatedRequestContext,
  match: RouteMatch,
  url: URL,
): Promise<Response> {
  switch (match.route.operation) {
    case "system.health":
      requireNoQuery(url);
      return apiResult(request, env, await application.services.owner.systemHealth(context));
    case "system.capabilities":
      requireNoQuery(url);
      return apiResult(request, env, await application.services.owner.systemCapabilities(context));
    case "research.catalog": {
      const blocked = await requireApplicationReady(request, application);
      if (blocked !== null) return blocked;
      return apiResult(
        request,
        env,
        await application.services.semantic.catalog(context, parseCatalogRequest(url)),
      );
    }
    case "research.orient": {
      requireNoQuery(url);
      const blocked = await requireApplicationReady(request, application);
      if (blocked !== null) return blocked;
      return apiResult(request, env, await application.services.semantic.orient(context,
        await readOrientationRequest(request, match.route.maximum_request_bytes)));
    }
    case "research.trace": {
      requireNoQuery(url);
      const blocked = await requireApplicationReady(request, application);
      if (blocked !== null) return blocked;
      const ref = match.params.ref;
      if (ref === undefined) throw new OrientationError("ORIENTATION_TRACE_INVALID", 400);
      return apiResult(request, env, await application.services.semantic.trace(context, { id: ref, revision: 1 }));
    }
    case "research.verify": {
      const blocked = await requireApplicationReady(request, application);
      if (blocked !== null) return blocked;
      return apiResult(
        request,
        env,
        await application.services.semantic.verify(
          context,
          await parseVerifyEvidenceRequest(request, match.route.maximum_request_bytes),
        ),
      );
    }
    case "research.open": {
      const blocked = await requireApplicationReady(request, application);
      if (blocked !== null) return blocked;
      const ref = match.params.ref;
      if (ref === undefined) throw new EvidenceHttpInputError(
        "EVIDENCE_HANDLE_REF_INVALID",
        400,
        "evidence handle path parameter is missing",
      );
      return application.services.semantic.open(
        context,
        parseEvidenceHandleRef(ref),
        parseEvidenceOpenRange(url),
      );
    }
    default:
      if (match.route.operation.startsWith("ingest.")) {
        const blocked = await requireApplicationReady(request, application);
        if (blocked !== null) return blocked;
        return apiResult(
          request,
          env,
          await dispatchIngestOperation(
            match.route.operation,
            request,
            url,
            match.params,
            match.route.maximum_request_bytes,
            context,
            application.services.owner,
          ),
        );
      }
      {
        const blocked = await requireApplicationReady(request, application);
        if (blocked !== null) return blocked;
        throw new CapabilityUnavailableError(match.route.operation);
      }
  }
}

function mapIngestAuthorityError(request: Request, error: IngestAuthorityError): Response {
  if (error.code === "INGEST_SETTLEMENT_UNCERTAIN") {
    return problem(request, 503, error.code, "Ingest authority settlement is uncertain", true);
  }
  if (error.code === "INGEST_AUTHORITY_MISSING") {
    return problem(request, 404, error.code, "Ingest authority does not exist", false);
  }
  if (error.code === "INGEST_OWNER_NOT_ACTIVE" || error.code === "INGEST_POLICY_DENIED") {
    return problem(request, 403, error.code, "Ingest admission is not authorized", false);
  }
  if (error.code === "INGEST_AUTHORITY_INPUT_INVALID") {
    return problem(request, 400, error.code, "Ingest authority input is invalid", false);
  }
  return problem(request, 409, error.code, "Ingest authority conflicts with durable state", false);
}

function mapIngestStorageError(request: Request, error: IngestStorageError): Response {
  if (error.retryable) {
    return problem(request, 503, error.code, "Ingest storage is temporarily unavailable", true);
  }
  if (error.code === "STAGING_SESSION_NOT_FOUND") {
    return problem(request, 404, error.code, "Staging session does not exist", false);
  }
  if (
    error.code === "BUNDLE_INPUT_INVALID" ||
    error.code === "BUNDLE_RESIDENCY_MISMATCH" ||
    error.code === "BUNDLE_FILE_SET_INVALID" ||
    error.code === "BUNDLE_HASH_MANIFEST_INVALID" ||
    error.code === "BUNDLE_TOTAL_SIZE_MISMATCH" ||
    error.code === "STAGING_FILE_UNKNOWN" ||
    error.code === "STAGING_PART_INVALID"
  ) {
    return problem(request, 400, error.code, "Ingest storage input is invalid", false);
  }
  return problem(request, 409, error.code, "Ingest storage state or integrity conflict", false);
}

function mapError(request: Request, error: unknown): Response {
  if (error instanceof OrientationError) return problem(request, error.status, error.code, "Orientation request cannot be completed", error.retryable);
  if (error instanceof ScopeServiceError) return problem(request, 409, error.code, "Current scope authority could not be established", false);
  if (error instanceof NavigationError) return problem(request, error.code === "NAVIGATION_LIMIT_EXCEEDED" ? 413 : 409,
    error.code, "Navigation is unavailable under the current scope", false);
  if (error instanceof AccessVerificationError) {
    const unavailable = error.code === "ACCESS_CONFIG_INVALID" ||
      error.code === "ACCESS_JWKS_UNAVAILABLE" ||
      error.code === "ACCESS_JWKS_INVALID";
    if (unavailable) {
      return problem(request, 503, error.code, "Authentication service is unavailable", true);
    }
    if (error.code === "ACCESS_SERVICE_PRINCIPAL_DENIED") {
      return problem(request, 403, error.code, "Authenticated service principal is not allowed", false);
    }
    return problem(
      request,
      401,
      error.code,
      "Authentication failed",
      false,
      { "www-authenticate": "Bearer realm=\"Cloudflare Access\"" },
    );
  }
  if (error instanceof HttpRequestError || error instanceof IngestHttpInputError ||
      error instanceof EvidenceHttpInputError) {
    return problem(request, error.status, error.code, error.message, error.retryable);
  }
  if (error instanceof IngestServiceError) {
    return problem(request, error.status, error.code, error.message, error.retryable);
  }
  if (error instanceof IngestAuthorityError) return mapIngestAuthorityError(request, error);
  if (error instanceof IngestStorageError) return mapIngestStorageError(request, error);
  if (error instanceof EvidenceRuntimeError) {
    if (error.retryable) {
      return problem(request, 503, error.code, "Exact evidence resolution is temporarily unavailable", true);
    }
    if (error.code === "EVIDENCE_AUTHORIZATION_DENIED") {
      return problem(request, 403, error.code, "Exact evidence access is not authorized", false);
    }
    if (error.code === "EVIDENCE_SCOPE_NOT_FOUND" || error.code === "EVIDENCE_SOURCE_NOT_FOUND" ||
        error.code === "EVIDENCE_HANDLE_NOT_FOUND" || error.code === "EVIDENCE_OBJECT_NOT_FOUND") {
      return problem(request, 404, error.code, "Exact evidence authority does not exist", false);
    }
    if (error.code === "EVIDENCE_SOURCE_NOT_LIVE" || error.code === "EVIDENCE_HANDLE_NOT_LIVE" ||
        error.code === "EVIDENCE_SCOPE_INVALIDATED" || error.code === "EVIDENCE_SCOPE_EXPIRED") {
      return problem(request, 410, error.code, "Exact evidence is no longer available", false);
    }
    if (error.code === "EVIDENCE_INPUT_INVALID" || error.code === "EVIDENCE_RANGE_INVALID" ||
        error.code === "EVIDENCE_LOCATOR_NOT_RESOLVABLE" || error.code === "EVIDENCE_PRECISION_UNSUPPORTED" ||
        error.code === "CITATION_SET_INVALID") {
      return problem(request, 400, error.code, "Exact evidence request is invalid", false);
    }
    return problem(request, 409, error.code, "Exact evidence authority conflicts with current state", false);
  }
  if (error instanceof CatalogInputError) {
    return problem(request, error.status, error.code, error.message, error.retryable);
  }
  if (error instanceof CapabilityUnavailableError) {
    return problem(
      request,
      501,
      error.code,
      "The operation is not available in this Worker generation",
      false,
    );
  }
  if (error instanceof RuntimeLimitError) {
    const requestError = error.label.startsWith("http.request");
    return problem(
      request,
      requestError ? 413 : 500,
      requestError ? "REQUEST_BODY_TOO_LARGE" : "RESPONSE_LIMIT_EXCEEDED",
      requestError ? "Request exceeds its bounded runtime envelope" : "Response exceeds its bounded runtime envelope",
      false,
    );
  }
  return problem(request, 500, "INTERNAL_ERROR", "Internal request processing failed", true);
}

// IMPLEMENTED_NOT_LIVE: ER-24 HTTP dispatch requires live owner/service Access receipts.
export async function handleHttp(
  request: Request,
  env: Env,
  executionContext: ExecutionContext,
  dependencies: HttpDependencies = {},
): Promise<Response> {
  const url = new URL(request.url);
  const resolved = resolveRoute(request, url.pathname);
  if (resolved.match === undefined) {
    if (resolved.allowedMethods.length > 0) {
      return problem(
        request,
        405,
        "METHOD_NOT_ALLOWED",
        "Method is not allowed for this route",
        false,
        { allow: resolved.allowedMethods.join(", ") },
      );
    }
    if (isApiPath(url.pathname)) {
      return problem(request, 404, "ROUTE_NOT_FOUND", "API route does not exist", false);
    }
    return env.ASSETS.fetch(request);
  }

  try {
    validateContentLength(request, resolved.match.route);
    if (resolved.match.route.auth === "public") {
      requireNoQuery(url);
      const readiness = await readReadiness(env);
      return jsonResponse({
        ready: readiness.ready,
        deployment_generation: readiness.deployment_generation,
        checked_at: readiness.checked_at,
      }, readiness.ready ? 200 : 503);
    }
    const verifier = dependencies.accessVerifier ?? configuredAccessVerifier(env);
    const identity = await verifier.verify(request);
    const context = authorize(request, resolved.match.route, identity);
    if (resolved.match.route.operation === "system.session") {
      requireNoQuery(url);
      return apiResult(request, env, {
        protocol: "eliotr.owner-session.v1",
        principal_ref: context.principal_ref,
        client_class: context.client_class,
        credential_generation: context.credential_generation,
        expires_at: identity.expires_at,
      });
    }
    const factory = dependencies.applicationFactory ?? createApplication;
    const application = factory({ env, executionContext });
    return await dispatch(request, env, application, context, resolved.match, url);
  } catch (error) {
    return mapError(request, error);
  }
}
