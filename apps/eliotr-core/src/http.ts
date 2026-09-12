import { dispatchFederationHttp } from "./federation-http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { OrientationError, readOrientationRequest } from "@eliotr/cloudflare-navigation";
import type {
  ApiProblem,
  ApplicationLifecycle,
  AuthenticatedRequestContext,
  CatalogRequest,
  QueryRequest,
  SourceRevisionsRequest,
  RouteDefinition,
  RawMarkdownConversionRequest,
} from "@eliotr/interfaces";
import { ROUTES } from "@eliotr/interfaces";
import {
  RUNTIME_LIMITS,
  serializeJsonWithinBytes,
} from "@eliotr/platform-cloudflare";
import {
  AccessVerificationError,
  createCloudflareAccessVerifier,
  type AccessIdentity,
  type AccessVerifier,
} from "@eliotr/cloudflare-access";
import {
  CapabilityUnavailableError,
  createApplication,
  type CompositionRootInput,
} from "./composition-root.js";
import type { Env } from "./env.js";
import { OWNER_E2E_AUDIENCE, OWNER_E2E_ISSUER, parseServicePrincipals, resolveOwnerE2ETestFetch } from "./env.js";
import {
  EvidenceHttpInputError,
  parseEvidenceHandleRef,
  parseEvidenceOpenRange,
  parseVerifyEvidenceRequest,
} from "./evidence-http.js";
import {
  ArtifactHttpInputError,
  parseArtifactRef,
  parseArtifactSectionRef,
} from "./artifact-draft-http.js";
import {
  dispatchIngestOperation,
} from "./ingest-http.js";
import { dispatchRawCaptureOperation } from "@eliotr/cloudflare-raw-ingest";
import { dispatchHttpSpecialRoute } from "./http-special-routes.js";
import { readRawMarkdownConversionRequest } from "@eliotr/cloudflare-markdown";
import { parseExhaustiveWorkflowJobsRequest } from "./research-query-http.js";
import { readReadiness } from "./readiness.js";
import { HttpRequestError, mapError } from "./http-errors.js";
export { HttpRequestError } from "./http-errors.js";
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
export function problem(
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
export function apiResult(request: Request, env: Env, data: unknown, status = 200): Response {
  return jsonResponse({ data, trace_id: traceId(request), deployment_generation: env.DEPLOYMENT_GENERATION }, status);
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
export function requireNoQuery(url: URL): void {
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
function parseSourceRevisionsRequest(url: URL): SourceRevisionsRequest {
  for (const key of url.searchParams.keys()) {
    if (!["source_id", "cursor", "limit"].includes(key)) {
      throw new HttpRequestError("UNKNOWN_QUERY_PARAMETER", 400, "Revision query contains an unknown parameter");
    }
  }
  const sourceId = singleQueryValue(url, "source_id");
  const cursor = singleQueryValue(url, "cursor");
  const rawLimit = singleQueryValue(url, "limit");
  if (sourceId === undefined || (rawLimit !== undefined && !/^(?:[1-9]|10)$/u.test(rawLimit))) {
    throw new HttpRequestError("SOURCE_REVISIONS_INPUT_INVALID", 400, "Source and a limit in [1, 10] are required");
  }
  return { source_id: sourceId, limit: rawLimit === undefined ? 10 : Number(rawLimit),
    ...(cursor === undefined ? {} : { cursor }) };
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
  const requiresReadiness = match.route.operation !== "system.health" &&
    match.route.operation !== "system.capabilities";
  if (requiresReadiness) {
    const blocked = await requireApplicationReady(request, application);
    if (blocked !== null) return blocked;
  }
  switch (match.route.operation) {
    case "system.health":
      requireNoQuery(url);
      return apiResult(request, env, await application.services.owner.systemHealth(context));
    case "system.capabilities":
      requireNoQuery(url);
      return apiResult(request, env, await application.services.owner.systemCapabilities(context));
    case "library.source.revisions": {
      return apiResult(request, env, await application.services.owner.sourceRevisions(context, parseSourceRevisionsRequest(url)));
    }
    case "library.active.readiness": {
      const sourceId = singleQueryValue(url, "source_id");
      if (sourceId === undefined || [...url.searchParams.keys()].some((key) => key !== "source_id")) {
        throw new HttpRequestError("LIBRARY_READINESS_INPUT_INVALID", 400, "exactly one source_id is required");
      }
      return apiResult(request, env, await application.services.owner.libraryReadiness(context, { source_id: sourceId }));
    }
    case "research.catalog": {
      return apiResult(
        request,
        env,
        await application.services.semantic.catalog(context, parseCatalogRequest(url)),
      );
    }
    case "research.orient": {
      requireNoQuery(url);
      return apiResult(request, env, await application.services.semantic.orient(context,
        await readOrientationRequest(request, match.route.maximum_request_bytes)));
    }
    case "research.trace": {
      requireNoQuery(url);
      const ref = match.params.ref;
      if (ref === undefined) throw new OrientationError("ORIENTATION_TRACE_INVALID", 400);
      return apiResult(request, env, await application.services.semantic.trace(context, { id: ref, revision: 1 }));
    }
    case "research.artifact": {
      requireNoQuery(url);
      const ref = match.params.ref;
      if (ref === undefined) throw new ArtifactHttpInputError("artifact reference path parameter is missing");
      return apiResult(request, env, await application.services.semantic.artifact(context, parseArtifactRef(ref)));
    }
    case "research.artifact.section":
    case "research.artifact.section.citations": {
      requireNoQuery(url);
      const ref = match.params.ref;
      const sectionRef = match.params.section_ref;
      if (ref === undefined) throw new ArtifactHttpInputError("artifact reference path parameter is missing");
      if (sectionRef === undefined) throw new ArtifactHttpInputError("section reference path parameter is missing");
      if (match.route.operation === "research.artifact.section.citations") {
        return apiResult(request, env, await application.services.semantic.artifactSectionCitations(
          context, parseArtifactRef(ref), parseArtifactSectionRef(sectionRef)));
      }
      return application.services.semantic.artifactSection(context, parseArtifactRef(ref), parseArtifactSectionRef(sectionRef));
    }
    case "research.wiki.propose": {
      requireNoQuery(url);
      return apiResult(
        request,
        env,
        await application.services.semantic.proposeWiki(
          context,
          await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes),
        ),
      );
    }
    case "research.verify": {
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
      if (match.route.operation === "ingest.raw.markdown") {
        const captureId = match.params.capture_id;
        if (captureId === undefined) throw new HttpRequestError("RAW_MARKDOWN_INPUT_INVALID", 400, "capture id is missing");
        requireNoQuery(url); const parsed = await readRawMarkdownConversionRequest(request, match.route.maximum_request_bytes); if (parsed === null) throw new HttpRequestError("RAW_MARKDOWN_INPUT_INVALID", 400, "conversion request is invalid");
        return apiResult(request, env, await application.services.owner.convertRawFileToMarkdown(context, captureId, parsed as unknown as RawMarkdownConversionRequest));
      }
      if (match.route.operation === "ingest.raw.capture" || match.route.operation === "ingest.raw.read") return apiResult(request, env, await dispatchRawCaptureOperation(match.route.operation, request, url, match.params.capture_id, match.route.maximum_request_bytes, context, application.services.owner));
      if (match.route.operation.startsWith("ingest.")) {
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
        const federation = await dispatchFederationHttp(
          request,
          env,
          context,
          {
            operation: match.route.operation,
            maximum_request_bytes: match.route.maximum_request_bytes,
            params: match.params,
          },
          url,
          application.services.federation,
        );
        if (federation !== null) {
          return federation.kind === "response"
            ? federation.response
            : apiResult(request, env, federation.body, federation.status);
        }
        if (match.route.operation === "research.query") {
          if (match.route.path === "/api/v1/research/query/jobs") {
            return apiResult(request, env, await application.services.semantic.queryJobs(
              context,
              parseExhaustiveWorkflowJobsRequest(url),
            ));
          }
          requireNoQuery(url);
          const workflowId = match.params.workflow_id;
          if (workflowId !== undefined && match.route.method === "GET") {
            return apiResult(request, env, await application.services.semantic.queryStatus(context, workflowId));
          }
          if (workflowId !== undefined && match.route.method === "DELETE") {
            return apiResult(request, env, await application.services.semantic.queryCancel(context, workflowId));
          }
          const data = await application.services.semantic.query(context, await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes) as QueryRequest);
          return apiResult(request, env, data, data && typeof data === "object" &&
            "workflow_instance_id" in data && !Object.hasOwn(data, "job") ? 202 : 200);
        }
        if (match.route.operation === "research.run") {
          requireNoQuery(url);
          if (request.method === "GET") {
            const workflowId = match.params.workflow_id;
            if (workflowId === undefined) throw new HttpRequestError("RESEARCH_RUN_ID_INVALID", 400, "workflow id is missing");
            return apiResult(request, env, await application.services.semantic.runStatus(context, workflowId));
          }
          return apiResult(request, env, await application.services.semantic.run(context, await readJsonBodyWithinBytes(request, match.route.maximum_request_bytes) as QueryRequest));
        }
        throw new CapabilityUnavailableError(match.route.operation);
      }
  }
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
    const special = await dispatchHttpSpecialRoute({ request, env, url, match: resolved.match, context, identity, dependencies });
    if (special !== null) return special;
    const factory = dependencies.applicationFactory ?? createApplication;
    const application = factory({ env, executionContext });
    return await dispatch(request, env, application, context, resolved.match, url);
  } catch (error) {
    return mapError(request, error, problem);
  }
}
