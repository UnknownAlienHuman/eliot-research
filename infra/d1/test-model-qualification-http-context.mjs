import assert from "node:assert/strict";
import process from "node:process";
import ts from "typescript";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { extractSourceText } from "./extract-application-sql.mjs";
import { createErasureReceiverTargetOverrides } from "./receiver-target-provenance.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const path = (file) => resolve(root, file);
const paths = {
  env: path("apps/eliotr-core/src/env.ts"), worker: path("apps/eliotr-core/src/index.ts"),
  http: path("apps/eliotr-core/src/http.ts"), composition: path("apps/eliotr-core/src/composition-root.ts"),
  ownerService: path("apps/eliotr-core/src/erasure-owner-service.ts"), appRuntime: path("apps/eliotr-core/src/erasure-runtime.ts"),
  modelHandler: path("apps/eliotr-core/src/research-model-qualification-http.ts"),
  routes: path("apps/eliotr-core/src/http-special-routes.ts"), access: path("apps/eliotr-core/src/http-request-auth.ts"),
  response: path("apps/eliotr-core/src/http-response.ts"), readiness: path("apps/eliotr-core/src/readiness.ts"),
  staticAsset: path("apps/eliotr-core/src/agent-inbox-static.ts"), apiDispatch: path("apps/eliotr-core/src/http-api-dispatch.ts"),
  routeTable: path("packages/interfaces/src/routes.ts"), agentTask: path("packages/cloudflare-http-protocol/src/agent-task-inbox-input.ts"),
  accessHelper: path("packages/cloudflare-access/src/owner-e2e-jwks-fetch.ts"),
  operations: path("packages/cloudflare-erasure-operations/src/erasure-runtime.ts"),
  factory: path("packages/cloudflare-erasure/src/factory.ts"), coreLocation: path("packages/cloudflare-erasure/src/core-location.ts"),
  searchLocation: path("packages/cloudflare-erasure/src/search-location.ts"),
  modelDispatch: path("packages/cloudflare-model-control/src/research-model-qualification-dispatch.ts"),
  modelSummary: path("packages/cloudflare-model-control/src/research-model-qualification-failure-summary.ts"),
  modelPrompt: path("packages/cloudflare-model-control/src/research-qualification-prompt.ts"),
  modelNative: path("packages/cloudflare-model-control/src/research-model-qualification.ts"),
};

const model = ({
  swapped = false,
  conflict = false,
  mutation = false,
  alias = false,
  routeAlias = false,
  routeMutation = false,
  computedOperation = false,
  publicRoute = false,
  alteredGuard = false,
  routeTableCast = false,
  routeTableUnknownCast = false,
  unsafeAccess = false,
  unsafeResponse = false,
  agentContainsTarget = false,
  nestedEnvCapture = false,
  routeFallthrough = false,
  fallbackEnvSink = false,
  predecessorEnvFallthrough = false,
  predecessorEnvBreak = false,
  predecessorConditionalBreak = false,
} = {}) => {
  const core = swapped ? "env.SEARCH_DB" : "env.CORE_DB";
  const search = swapped ? "env.CORE_DB" : "env.SEARCH_DB";
  const httpEnv = routeAlias ? "routeEnv" : "env";
  const modelRoute = "system.research.model-qualification";
  const predecessorCase = predecessorEnvFallthrough
    ? 'case "system.before": mutateOtherSpecial(input.env);'
    : predecessorEnvBreak ? 'case "system.before": mutateOtherSpecial(input.env); break;'
      : predecessorConditionalBreak ? 'case "system.before": if (input.identity !== null) break; mutateOtherSpecial(input.env);' : "";
  const sources = new Map([
    [paths.env, `export interface D1PreparedStatement { bind(...values: unknown[]): D1PreparedStatement; first<T = unknown>(): Promise<T | null>; run(): Promise<void> }
export interface D1Database { prepare(sql: string): D1PreparedStatement }
export interface Env { readonly CORE_DB: D1Database; readonly SEARCH_DB: D1Database; readonly DEPLOYMENT_GENERATION: string; readonly ENVIRONMENT: string; readonly ACCESS_TEAM_DOMAIN?: string; readonly ACCESS_AUDIENCE?: string; readonly ACCESS_SERVICE_PRINCIPALS?: string; readonly ACCESS_TEST_JWKS_URL?: string }
export interface ExportedHandler<E> { fetch(request: Request, env: E, executionContext: unknown): unknown }`],
    [paths.worker, `import type { Env, ExportedHandler } from "./env.js"; import { handleHttp } from "./http.js";
export default { fetch(request: Request, env: Env, context: unknown): unknown { return handleHttp(request, env, context); } } satisfies ExportedHandler<Env>;`],
    [paths.composition, `import type { Env } from "./env.js"; import { createErasureOwnerService } from "./erasure-owner-service.js";
function ownerApi(env: Env): unknown { return { erase: () => createErasureOwnerService({ env }) }; }
function semanticApi(env: Env): void { void env; }
export function createApplication(input: { readonly env: Env; readonly executionContext: unknown }): unknown { ${fallbackEnvSink ? "semanticApi(input.env);" : ""} return ownerApi(input.env); }`],
    [paths.ownerService, `import type { Env } from "./env.js"; import { createConfiguredErasureCoordinator } from "./erasure-runtime.js";
export function createErasureOwnerService(input: { readonly env: Env }): unknown { return createConfiguredErasureCoordinator(input.env); }`],
    [paths.appRuntime, `import type { Env } from "./env.js"; import { createConfiguredErasureCoordinator as inLibrary } from "../../../packages/cloudflare-erasure-operations/src/erasure-runtime.js";
export function createConfiguredErasureCoordinator(env: Env): unknown { return inLibrary({ core_database: env.CORE_DB, search_database: env.SEARCH_DB }); }`],
    [paths.operations, `import type { D1Database } from "../../../apps/eliotr-core/src/env.js"; import { createConfiguredErasureBackend } from "../../cloudflare-erasure/src/factory.js";
export function createConfiguredErasureCoordinator(dependencies: { readonly core_database: D1Database; readonly search_database: D1Database }): unknown { return createConfiguredErasureBackend({ ...dependencies }); }`],
    [paths.factory, `import type { D1Database } from "../../../apps/eliotr-core/src/env.js"; import { createD1CoreErasureLocationPort } from "./core-location.js"; import { createD1SearchErasureLocationPort } from "./search-location.js";
export function createConfiguredErasureBackend(dependencies: { readonly core_database: D1Database; readonly search_database: D1Database }): unknown { createD1CoreErasureLocationPort({ database: dependencies.core_database }); createD1SearchErasureLocationPort({ database: dependencies.search_database }); return {}; }`],
    [paths.coreLocation, `import type { D1Database } from "../../../apps/eliotr-core/src/env.js"; export function createD1CoreErasureLocationPort(input: { readonly database: D1Database }): void { input.database.prepare("SELECT 1 FROM fixture_core").first(); }`],
    [paths.searchLocation, `import type { D1Database } from "../../../apps/eliotr-core/src/env.js"; export function createD1SearchErasureLocationPort(input: { readonly database: D1Database }): void { input.database.prepare("SELECT 1 FROM fixture_search").first(); }`],
    [paths.routeTable, `export interface RouteDefinition { readonly method: string; readonly path: string; readonly operation: string; readonly auth: string; readonly maximum_request_bytes: number; readonly response_mode: string }
export const ROUTES: readonly RouteDefinition[] = [
  { method: "GET", path: "/healthz", operation: "system.health.public", auth: "public", maximum_request_bytes: 0, response_mode: "json" },
  { method: "POST", path: "/api/v1/system/research-model-qualification", operation: "${modelRoute}", auth: "${publicRoute ? "public" : "owner"}", maximum_request_bytes: 1024, response_mode: "json" },
${routeTableUnknownCast ? "] as unknown as readonly RouteDefinition[];" : routeTableCast ? "] as RouteDefinition[];" : "] as const;"}`],
    [paths.http, `import type { Env } from "./env.js"; import { ROUTES, type RouteDefinition } from "../../../packages/interfaces/src/routes.js"; import { createApplication } from "./composition-root.js";
import { dispatchHttpSpecialRoute } from "./http-special-routes.js"; import { dispatchHttpApiRoute } from "./http-api-dispatch.js"; import { readReadiness } from "./readiness.js"; import { fetchStaticAsset } from "./agent-inbox-static.js"; import { configuredAccessVerifier } from "./http-request-auth.js";
interface RouteMatch { readonly route: RouteDefinition; readonly params: Readonly<Record<string, string>> }
function matchPattern(pattern: string, pathname: string): Readonly<Record<string, string>> | null { return pattern === pathname ? {} : null; }
function isApiPath(pathname: string): boolean { return pathname.startsWith("/api/"); }
function requireNoQuery(_url: URL): void {} function validateContentLength(_request: Request, _route: RouteDefinition): void {}
function jsonResponse(_data: unknown): Response { return new Response(); } function authorize(_request: Request, _route: RouteDefinition, _identity: unknown): unknown { return {}; }
function mapError(_request: Request, _error: unknown): Response { return new Response(); }
function resolveRoute(request: Request, pathname: string): { readonly match?: RouteMatch; readonly allowedMethods: readonly string[] } {
  const pathMatches = ROUTES.flatMap((route) => { const params = matchPattern(route.path, pathname); return params === null ? [] : [{ route, params }]; });
  const match = pathMatches.find(({ route }) => route.method === request.method);
  if (match !== undefined) return { match, allowedMethods: [] }; return { allowedMethods: [] };
}
export async function handleHttp(request: Request, env: Env, executionContext: unknown, dependencies: { readonly applicationFactory?: typeof createApplication } = {}): Promise<Response> {
  ${nestedEnvCapture ? "const capture = () => env.CORE_DB;" : ""}
  ${routeMutation ? "env.CORE_DB = env.SEARCH_DB;" : ""} ${routeAlias ? "const routeEnv: Env = env;" : ""}
  const url = new URL(request.url); const resolved = resolveRoute(request, url.pathname);
  if (resolved.match === undefined) { if (resolved.allowedMethods.length > 0) return new Response(); if (isApiPath(url.pathname)) return new Response(); return fetchStaticAsset(request, env, url); }
  try {
    validateContentLength(request, resolved.match.route);
    if (resolved.match.route.auth === "public") { requireNoQuery(url); const readiness = await readReadiness(env); return jsonResponse(readiness); }
    const verifier = configuredAccessVerifier(env); const identity = await verifier.verify(request); const context = authorize(request, resolved.match.route, identity);
    const special = await dispatchHttpSpecialRoute({ request, env: ${httpEnv}, url, match: resolved.match, context, identity, dependencies });
    if (special ${alteredGuard ? "=== null" : "!== null"}) return special;
    const factory = dependencies.applicationFactory ?? createApplication; const application = factory({ env, executionContext });
    return await dispatchHttpApiRoute(request, env, application, context, resolved.match, url);
  } catch (error) { return mapError(request, error); }
}`],
    [paths.routes, `import type { Env } from "./env.js"; import { handleResearchModelQualification } from "./research-model-qualification-http.js"; import { isAgentTaskHttpOperation } from "../../../packages/cloudflare-http-protocol/src/agent-task-inbox-input.js";
interface RouteDefinition { readonly operation: string; readonly maximum_request_bytes: number } interface RouteMatch { readonly route: RouteDefinition; readonly params: Readonly<Record<string, string>> }
interface Input { readonly request: Request; readonly env: Env; readonly url: URL; readonly match: RouteMatch; readonly context: unknown; readonly identity: unknown; readonly dependencies: unknown }
function requireDriveExchangeTransport(env: Env): void { void env.CORE_DB; } function handleAgentTaskHttp(request: Request, env: Env): Response { void request; void env.SEARCH_DB; return new Response(); }
function handleOtherSpecial(env: Env): Response { void env.CORE_DB; return new Response(); }
${predecessorEnvFallthrough || predecessorEnvBreak || predecessorConditionalBreak
    ? 'function mutateOtherSpecial(env: Env): Response { const key: keyof Env = "CORE_DB"; env[key] = env.SEARCH_DB; return new Response(); }' : ""}
export async function dispatchHttpSpecialRoute(input: Input): Promise<Response | null> {
  if (input.match.route.operation.startsWith("google.oauth.") || input.match.route.operation.startsWith("google.connection.")) requireDriveExchangeTransport(input.env);
  if (isAgentTaskHttpOperation(input.match.route.operation)) return handleAgentTaskHttp(input.request, input.env);
  switch (input.match.route.${computedOperation ? '["operation"]' : "operation"}) {
    ${predecessorCase}
    case "${modelRoute}": ${routeFallthrough ? "handleResearchModelQualification(input.request, input.env);" : "return handleResearchModelQualification(input.request, input.env);"}
    case "system.other": return handleOtherSpecial(input.env);
    default: return null;
  }
}`],
    [paths.agentTask, `const AGENT_TASK_INBOX_OPERATIONS = ["research.agent-task.pull", "research.agent-task.progress", "research.agent-task.result", "research.agent-task.status",${agentContainsTarget ? ` "${modelRoute}",` : ""}] as const;
export type AgentTaskInboxOperation = typeof AGENT_TASK_INBOX_OPERATIONS[number];
export function isAgentTaskHttpOperation(value: string): value is AgentTaskInboxOperation { return (AGENT_TASK_INBOX_OPERATIONS as readonly string[]).includes(value); }`],
    [paths.readiness, `import type { Env } from "./env.js"; export async function readReadiness(env: Env): Promise<unknown> { await env.CORE_DB.prepare("SELECT 1 FROM readiness").first(); return { generation: env.DEPLOYMENT_GENERATION }; }`],
    [paths.staticAsset, `import type { Env } from "./env.js"; export async function fetchStaticAsset(_request: Request, env: Env, _url: URL): Promise<Response> { void env.SEARCH_DB; return new Response(); }`],
    [paths.access, `import type { Env } from "./env.js"; import { resolveOwnerE2ETestFetch } from "../../../packages/cloudflare-access/src/owner-e2e-jwks-fetch.js";
export interface AccessVerifier { verify(request: Request): Promise<unknown> } function unsafeSink(value: unknown): void { void value; }
export function configuredAccessVerifier(env: Env): AccessVerifier { ${unsafeAccess ? "unsafeSink(env);" : ""}
  const team = env.ACCESS_TEAM_DOMAIN; const audience = env.ACCESS_AUDIENCE; const environment = env.ENVIRONMENT; const principals = env.ACCESS_SERVICE_PRINCIPALS;
  const testFetch = resolveOwnerE2ETestFetch(env, String(team ?? "") + "/" + String(audience ?? ""));
  return { async verify(request: Request): Promise<unknown> { return { request, team, audience, environment, principals, testFetch }; } };
}`],
    [paths.accessHelper, `import type { Env } from "../../../apps/eliotr-core/src/env.js"; export function resolveOwnerE2ETestFetch(env: Env, certsUrl: string): unknown {
  const override = env.ACCESS_TEST_JWKS_URL; const environment = env.ENVIRONMENT;
  return override === undefined ? undefined : () => String(certsUrl) + "/" + String(environment) + "/" + String(override);
}`],
    [paths.response, `import type { Env } from "./env.js"; function unsafeSink(value: unknown): void { void value; }
export function apiResult(request: Request, env: Env, data: unknown): Response { ${unsafeResponse ? "unsafeSink(env);" : ""}
  return new Response(JSON.stringify({ request: request.url, data, generation: env.DEPLOYMENT_GENERATION }));
}`],
    [paths.apiDispatch, `import type { Env } from "./env.js"; export async function dispatchHttpApiRoute(_request: Request, env: Env, _application: unknown, _context: unknown, _match: unknown, _url: URL): Promise<Response> { void env.CORE_DB; return new Response(); }`],
    [paths.modelHandler, `import type { Env } from "./env.js"; import { createResearchModelQualificationDispatch } from "../../../packages/cloudflare-model-control/src/research-model-qualification-dispatch.js"; import { apiResult } from "./http-response.js";
export async function handleResearchModelQualification(request: Request, env: Env): Promise<Response> {
  ${mutation ? "env.CORE_DB = env.SEARCH_DB;" : ""} ${alias ? "const envAlias: Env = env;" : ""}
  const service = createResearchModelQualificationDispatch({ core_database: ${alias ? "envAlias.CORE_DB" : core}, search_database: ${alias ? "envAlias.SEARCH_DB" : search} });
  const observed = await service.execute(); return apiResult(request, env, observed);
}`],
    [paths.modelDispatch, `import type { D1Database, Env } from "../../../apps/eliotr-core/src/env.js"; import { createResearchQualificationPromptCompiler } from "./research-qualification-prompt.js"; import { createResearchModelQualificationNativeExecution } from "./research-model-qualification.js";
import { recordResearchModelQualificationFailureSummary } from "./research-model-qualification-failure-summary.js";
interface Dependencies { readonly core_database: D1Database; readonly search_database: D1Database }
export function createResearchModelQualificationDispatch(dependencies: Dependencies): { execute(): Promise<unknown> } {
  return Object.freeze({ async execute(): Promise<unknown> {
    createResearchQualificationPromptCompiler({ core_database: dependencies.core_database, search_database: dependencies.search_database });
    createResearchModelQualificationNativeExecution({ database: dependencies.core_database });
    await recordResearchModelQualificationFailureSummary(dependencies.core_database);
    return { result: "failed" };
  } });
}${conflict ? `\nexport function conflictingModelCaller(env: Env): void { createResearchModelQualificationDispatch({ core_database: env.SEARCH_DB, search_database: env.CORE_DB }); }` : ""}`],
    [paths.modelSummary, `import type { D1Database } from "../../../apps/eliotr-core/src/env.js";
export async function readResearchModelQualificationFailureSummary(database: D1Database): Promise<void> {
  await database.prepare("SELECT probe_idempotency_key,probe_input_sha256,claim_ref,phase,failure_code,safe_response_reason,transport_failure_reason,observed_http_status,summary_sha256,observed_at FROM model_route_qualification_failure_summary WHERE probe_idempotency_key=?1 LIMIT 1").bind("key").first();
  await database.prepare("SELECT probe_input_sha256,claim_ref,state,observation_sha256,observation_json,completed_at FROM model_route_qualification_dispatch WHERE probe_idempotency_key=?1 LIMIT 1").bind("key").first();
}
export async function recordResearchModelQualificationFailureSummary(database: D1Database): Promise<void> {
  await database.prepare("INSERT INTO model_route_qualification_failure_summary(probe_idempotency_key,probe_input_sha256,claim_ref,phase,failure_code,safe_response_reason,transport_failure_reason,observed_http_status,summary_sha256) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(probe_idempotency_key) DO NOTHING").bind("a","b","c","d","e","f","g",200,"h").run();
  await readResearchModelQualificationFailureSummary(database);
}`],
    [paths.modelPrompt, `import type { D1Database } from "../../../apps/eliotr-core/src/env.js"; export function createResearchQualificationPromptCompiler(input: { readonly core_database: D1Database; readonly search_database: D1Database }): void { void input; }`],
    [paths.modelNative, `import type { D1Database } from "../../../apps/eliotr-core/src/env.js"; export function createResearchModelQualificationNativeExecution(input: { readonly database: D1Database }): void { void input; }`],
  ]);
  const options = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, skipLibCheck: true };
  const host = ts.createCompilerHost(options);
  const sourceEntries = [...sources];
  assert.deepEqual(sourceEntries.filter(([file]) => typeof file !== "string")
    .map(([file, text]) => [file, String(text).slice(0, 48)]), [], "every virtual source has an absolute path");
  const virtual = new Map(sourceEntries.map(([file, text]) => [file.replaceAll("\\", "/").toLowerCase(), text]));
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (path) => virtual.has(resolve(path).replaceAll("\\", "/").toLowerCase()) || fileExists(path);
  host.readFile = (path) => virtual.get(resolve(path).replaceAll("\\", "/").toLowerCase()) ?? readFile(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = virtual.get(resolve(path).replaceAll("\\", "/").toLowerCase());
    return text === undefined ? getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(path, text, languageVersion, true);
  };
  const files = [...sources.keys()];
  const program = ts.createProgram(files, options, host);
  const overrides = createErasureReceiverTargetOverrides(files, root, program);
  if (!swapped && !conflict && !mutation && !alias && !routeAlias && !routeMutation && !computedOperation
      && !publicRoute && !alteredGuard && !routeTableCast && !routeTableUnknownCast && !unsafeAccess
      && !unsafeResponse && !agentContainsTarget && !nestedEnvCapture && !routeFallthrough && !fallbackEnvSink
      && !predecessorEnvFallthrough && !predecessorEnvBreak && !predecessorConditionalBreak) {
    const core = extractSourceText(sources.get(paths.coreLocation), paths.coreLocation,
      overrides.get(paths.coreLocation.replaceAll("\\", "/").toLowerCase())).queries;
    const search = extractSourceText(sources.get(paths.searchLocation), paths.searchLocation,
      overrides.get(paths.searchLocation.replaceAll("\\", "/").toLowerCase())).queries;
    assert.deepEqual(core.map((query) => query.targetStore), ["core"], "generic fallback still binds CORE erasure SQL");
    assert.deepEqual(search.map((query) => query.targetStore), ["search"], "generic fallback still binds SEARCH erasure SQL");
  }
  const summaryPath = paths.modelSummary.replaceAll("\\", "/").toLowerCase();
  return extractSourceText(sources.get(paths.modelSummary), paths.modelSummary, overrides.get(summaryPath)).queries;
};

const sql = [
  "SELECT probe_idempotency_key,probe_input_sha256,claim_ref,phase,failure_code,safe_response_reason,transport_failure_reason,observed_http_status,summary_sha256,observed_at FROM model_route_qualification_failure_summary WHERE probe_idempotency_key=?1 LIMIT 1",
  "SELECT probe_input_sha256,claim_ref,state,observation_sha256,observation_json,completed_at FROM model_route_qualification_dispatch WHERE probe_idempotency_key=?1 LIMIT 1",
  "INSERT INTO model_route_qualification_failure_summary(probe_idempotency_key,probe_input_sha256,claim_ref,phase,failure_code,safe_response_reason,transport_failure_reason,observed_http_status,summary_sha256) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(probe_idempotency_key) DO NOTHING",
];
const positive = model();
assert.deepEqual(positive.map((query) => query.sql), sql, "the synthetic owner POST path retains all three production summary statements");
assert.deepEqual(positive.map((query) => query.targetStore), ["core", "core", "core"], JSON.stringify(positive.map(({ targetStore, targetStatus, receiver }) => ({ targetStore, targetStatus, receiver }))));
assert.deepEqual(positive.map((query) => query.targetStatus), Array(3).fill("resolved-local-const-alias"));
assert.deepEqual(model({ swapped: true }).map((query) => query.targetStore), ["search", "search", "search"]);
assert.deepEqual(model({ fallbackEnvSink: true }).map((query) => query.targetStore), ["core", "core", "core"],
  "the reachable fallback application cannot poison the selected model route");
assert.deepEqual(model({ predecessorEnvBreak: true }).map((query) => query.targetStore), ["core", "core", "core"],
  "a preceding mutating Env route separated by this switch's break cannot poison the selected model route");
for (const [name, options] of [
  ["conflicting caller", { conflict: true }], ["handler alias", { alias: true }], ["handler mutation", { mutation: true }],
  ["route Env alias", { routeAlias: true }], ["route Env mutation", { routeMutation: true }],
  ["computed operation", { computedOperation: true }], ["public route", { publicRoute: true }],
  ["changed non-null guard", { alteredGuard: true }], ["escaping access consumer", { unsafeAccess: true }],
  ["non-const route cast", { routeTableCast: true }], ["unknown route cast", { routeTableUnknownCast: true }],
  ["escaping response consumer", { unsafeResponse: true }], ["agent predicate overlap", { agentContainsTarget: true }],
  ["nested Env capture", { nestedEnvCapture: true }], ["model case fallthrough", { routeFallthrough: true }],
  ["predecessor Env fallthrough", { predecessorEnvFallthrough: true }],
  ["predecessor conditional break", { predecessorConditionalBreak: true }],
]) {
  const rejected = model(options);
  assert.equal(rejected.length, 3, `${name} keeps all three SQL sites visible`);
  assert.deepEqual(rejected.map((query) => query.targetStore), ["unknown", "unknown", "unknown"],
    `${name} must fail closed`);
}
process.stdout.write("D1 model qualification HTTP-context fixtures PASS\n");
