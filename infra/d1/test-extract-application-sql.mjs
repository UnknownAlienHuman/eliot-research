import process from "node:process";
import assert from "node:assert/strict";
import ts from "typescript";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { extractSourceText } from "./extract-application-sql.mjs";
import { prepareDeclarationMetadataKey, PREPARE_DECLARATION_KIND } from "./prepare-declaration-provenance.mjs";
import { createErasureReceiverTargetOverrides } from "./receiver-target-provenance.mjs";

const fixture = extractSourceText(`
const shared = "SELECT * FROM source";
function registered(kind: string): string {
  if (kind === "source") return shared + " WHERE state='READY'";
  return "SELECT * FROM project";
}
const byState = (state: string) => \`SELECT * FROM source WHERE state='\u0024{state}'\`;
const db = { prepare: (sql: string) => sql };
db.prepare(registered("source"));
db.prepare(registered("project"));
db.prepare(byState("READY"));
db.prepare(
  \`SELECT * FROM source WHERE source_id=\u0024{sourceId}\`,
);
`);

assert.deepEqual(fixture.queries.map((query) => query.sql), [
  "SELECT * FROM source WHERE state='READY'",
  "SELECT * FROM project",
  "SELECT * FROM source WHERE state='READY'",
]);
assert.equal(fixture.unresolved.length, 1);
assert.equal(fixture.unresolved[0].reason, "dynamic-or-unresolved");
assert.ok(fixture.queries.every((query) => query.prepareDeclarationKind === PREPARE_DECLARATION_KIND.noSharedProgram));
assert.equal(fixture.unresolved[0].prepareDeclarationKind, PREPARE_DECLARATION_KIND.noSharedProgram);

const metadataPath = "C:/fixture/prepare-declaration-metadata.ts";
const metadataSource = `
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
db.prepare("SELECT 1 FROM metadata_query").bind(runtimeValue).first();
db.prepare(runtimeSql);
`;
const metadata = new Map([
  [prepareDeclarationMetadataKey(metadataPath, metadataSource.indexOf("db.prepare")), PREPARE_DECLARATION_KIND.database],
  [prepareDeclarationMetadataKey(metadataPath, metadataSource.indexOf("db.prepare", metadataSource.indexOf("db.prepare") + 1)), PREPARE_DECLARATION_KIND.session],
]);
const metadataFixture = extractSourceText(metadataSource, metadataPath, undefined, metadata);
assert.equal(metadataFixture.queries[0].prepareDeclarationKind, PREPARE_DECLARATION_KIND.database);
assert.equal(metadataFixture.queries[0].targetStore, "unknown",
  "canonical declaration metadata does not promote an unknown runtime database target");
assert.equal(metadataFixture.queries[0].bindingArity, 1,
  "declaration metadata does not change the existing bind-arity result");
assert.equal(metadataFixture.unresolved[0].prepareDeclarationKind, PREPARE_DECLARATION_KIND.session);
assert.equal(metadataFixture.unresolved[0].targetStore, "unknown");

const changed = extractSourceText(`
const db = { prepare: (sql: string) => sql };
db.prepare(\`SELECT * FROM \u0024{runtimeTable}\`);
`);
assert.equal(changed.queries.length, 0);
assert.equal(changed.unresolved.length, 1);

const mixed = extractSourceText(`
const registeredSql = "SELECT * FROM source";
const db = { prepare: (sql: string) => sql };
function registeredRead(sql: string): void { db.prepare(sql); }
registeredRead(registeredSql);
registeredRead(runtimeSql);
`);
assert.equal(mixed.queries.length, 1);
assert.equal(mixed.queries[0].sql, "SELECT * FROM source");
assert.equal(mixed.unresolved.length, 1);

const shadows = extractSourceText(`
const query = "SELECT * FROM source";
const db = { prepare: (sql: string) => sql };
function parameterShadow(query: string): void { db.prepare(query); }
function localShadow(): void {
  const query = runtimeSql;
  db.prepare(query);
}
parameterShadow(runtimeSql);
localShadow();
`);
assert.equal(shadows.queries.length, 0);
assert.equal(shadows.unresolved.length, 2);

const unknownBranch = extractSourceText(`
const fallbackSql = "SELECT * FROM safe_table";
const db = { prepare: (sql: string) => sql };
function guardedRead(): string {
  const runtimeCondition = getRuntimeCondition();
  if (runtimeCondition) return "SELECT * FROM dynamic_table";
  return fallbackSql;
}
db.prepare(guardedRead());
`);
assert.equal(unknownBranch.queries.length, 0);
assert.equal(unknownBranch.unresolved.length, 1);

const targetAliases = extractSourceText(`
import importedDb from "imported-db";
function directCanonical(env: Environment): void {
  env.CORE_DB.prepare("SELECT 1 FROM direct_core").first();
  env.SEARCH_DB.prepare("SELECT 1 FROM direct_search").first();
}
function aliases(env: Environment): void {
  const core = env.CORE_DB;
  const coreAgain = core;
  coreAgain.prepare("SELECT 1 FROM core_alias").bind(1).first();
  const search = env["SEARCH_DB"];
  const searchAgain = search;
  searchAgain.prepare("SELECT 1 FROM search_alias").run();
  {
    const nested = core;
    nested.prepare("SELECT 1 FROM nested_core_alias").all();
  }
}
function nestedShadow(env: Environment): void {
  const db = env.CORE_DB;
  {
    const db = makeDatabase();
    db.prepare("SELECT 1 FROM inner_shadow").first();
  }
  db.prepare("SELECT 1 FROM outer_after_shadow").first();
}
function envShadow(env: Environment): void {
  {
    const env = makeEnvironment();
    const db = env.CORE_DB;
    db.prepare("SELECT 1 FROM env_shadow").first();
  }
}
function unsupported(env: Environment, parameterDb: Database): void {
  parameterDb.prepare("SELECT 1 FROM parameter_receiver").first();
  let mutable = env.CORE_DB;
  mutable.prepare("SELECT 1 FROM let_receiver").first();
  const reassigned = env.CORE_DB;
  reassigned = makeDatabase();
  reassigned.prepare("SELECT 1 FROM reassigned_receiver").first();
  const { CORE_DB: destructured } = env;
  destructured.prepare("SELECT 1 FROM destructured_receiver").first();
  const conditional = flag ? env.CORE_DB : env.SEARCH_DB;
  conditional.prepare("SELECT 1 FROM conditional_receiver").first();
  const factory = makeDatabase(env.CORE_DB);
  factory.prepare("SELECT 1 FROM factory_receiver").first();
  const forward = later;
  forward.prepare("SELECT 1 FROM forward_reference").first();
  const later = env.CORE_DB;
}
function closureCapture(env: Environment): void {
  const db = env.CORE_DB;
  function nested(): void { db.prepare("SELECT 1 FROM closure_capture").first(); }
}
function callSiteForwarding(db: Database): void {
  db.prepare("SELECT 1 FROM callsite_parameter").first();
}
function invokeForwarding(env: Environment): void { callSiteForwarding(env.CORE_DB); }
function importedReceiver(): void {
  importedDb.prepare("SELECT 1 FROM imported_receiver").first();
}
function cycle(env: Environment): void {
  const first = second;
  const second = first;
  first.prepare("SELECT 1 FROM cyclic_alias").first();
}
function ambiguous(env: Environment): void {
  const duplicate = env.CORE_DB;
  const duplicate = env.SEARCH_DB;
  duplicate.prepare("SELECT 1 FROM ambiguous_alias").first();
}
function mutatedEnvironment(env: Environment): void {
  const db = env.CORE_DB;
  env.CORE_DB = makeDatabase();
  db.prepare("SELECT 1 FROM mutated_environment").first();
}
function mutatedThroughEnvironmentAlias(env: Environment): void {
  const db = env.CORE_DB;
  const localEnv = env;
  localEnv.SEARCH_DB = makeDatabase();
  db.prepare("SELECT 1 FROM mutated_through_env_alias").first();
}
function nestedEnvironmentMutation(env: Environment): void {
  function changeBinding(): void { env.CORE_DB = makeDatabase(); }
  changeBinding();
  const db = env.CORE_DB;
  db.prepare("SELECT 1 FROM nested_environment_mutation").first();
}
function catchShadow(env: Environment): void {
  const db = env.CORE_DB;
  try { throw makeDatabase(); } catch (db) {
    db.prepare("SELECT 1 FROM catch_shadow").first();
  }
  db.prepare("SELECT 1 FROM outer_after_catch").first();
}
class ConstructorReceiver {
  constructor(private readonly db: Database) {}
  read(): void { this.db.prepare("SELECT 1 FROM constructor_field").first(); }
}
class ThisEnvironmentReceiver {
  read(): void {
    this.env.CORE_DB.prepare("SELECT 1 FROM direct_this_env").first();
    const db = this.env.CORE_DB;
    db.prepare("SELECT 1 FROM this_env_alias").first();
  }
}
`);
const targetBySql = new Map(targetAliases.queries.map((query) => [query.sql, query]));
assert.equal(targetBySql.get("SELECT 1 FROM direct_core").targetStore, "core");
assert.equal(targetBySql.get("SELECT 1 FROM direct_core").targetStatus, "resolved-direct-binding");
assert.equal(targetBySql.get("SELECT 1 FROM direct_search").targetStore, "search");
assert.equal(targetBySql.get("SELECT 1 FROM direct_search").targetStatus, "resolved-direct-binding");
assert.equal(targetBySql.get("SELECT 1 FROM direct_this_env").targetStore, "core");
assert.equal(targetBySql.get("SELECT 1 FROM direct_this_env").targetStatus, "resolved-direct-binding");
assert.equal(targetBySql.get("SELECT 1 FROM core_alias").targetStore, "core");
assert.equal(targetBySql.get("SELECT 1 FROM core_alias").targetStatus, "resolved-local-const-alias");
assert.equal(targetBySql.get("SELECT 1 FROM search_alias").targetStore, "search");
assert.equal(targetBySql.get("SELECT 1 FROM nested_core_alias").targetStore, "core");
assert.equal(targetBySql.get("SELECT 1 FROM outer_after_shadow").targetStore, "core");
for (const sql of [
  "SELECT 1 FROM inner_shadow",
  "SELECT 1 FROM env_shadow",
  "SELECT 1 FROM parameter_receiver",
  "SELECT 1 FROM let_receiver",
  "SELECT 1 FROM reassigned_receiver",
  "SELECT 1 FROM destructured_receiver",
  "SELECT 1 FROM conditional_receiver",
  "SELECT 1 FROM factory_receiver",
  "SELECT 1 FROM forward_reference",
  "SELECT 1 FROM closure_capture",
  "SELECT 1 FROM callsite_parameter",
  "SELECT 1 FROM imported_receiver",
  "SELECT 1 FROM cyclic_alias",
  "SELECT 1 FROM ambiguous_alias",
  "SELECT 1 FROM mutated_environment",
  "SELECT 1 FROM mutated_through_env_alias",
  "SELECT 1 FROM nested_environment_mutation",
  "SELECT 1 FROM catch_shadow",
  "SELECT 1 FROM constructor_field",
  "SELECT 1 FROM this_env_alias",
]) {
  assert.equal(targetBySql.get(sql).targetStore, "unknown", sql);
}
assert.equal(targetBySql.get("SELECT 1 FROM outer_after_catch").targetStore, "core");

const projectRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const typedD1Fixture = ({
  swapped = false,
  conflictingCaller = false,
  facadeSwapped = false,
  facadeMutation = false,
  facadeEscaped = false,
  mcpProjection = "none",
} = {}) => {
  const paths = {
    env: resolve(projectRoot, "apps/eliotr-core/src/env.ts"),
    worker: resolve(projectRoot, "apps/eliotr-core/src/index.ts"),
    http: resolve(projectRoot, "apps/eliotr-core/src/http.ts"),
    composition: resolve(projectRoot, "apps/eliotr-core/src/composition-root.ts"),
    ownerService: resolve(projectRoot, "apps/eliotr-core/src/erasure-owner-service.ts"),
    appRuntime: resolve(projectRoot, "apps/eliotr-core/src/erasure-runtime.ts"),
    operations: resolve(projectRoot, "packages/cloudflare-erasure-operations/src/erasure-runtime.ts"),
    factory: resolve(projectRoot, "packages/cloudflare-erasure/src/factory.ts"),
    core: resolve(projectRoot, "packages/cloudflare-erasure/src/core-location.ts"),
    search: resolve(projectRoot, "packages/cloudflare-erasure/src/search-location.ts"),
    projection: resolve(projectRoot, "packages/cloudflare-workspace-mcp/src/workspace-mcp-env.ts"),
  };
  const d1TypeImport = "import type { D1Database } from '../../../apps/eliotr-core/src/env.js';";
  const coreArgument = swapped ? "dependencies.search_database" : "dependencies.core_database";
  const searchArgument = swapped ? "dependencies.core_database" : "dependencies.search_database";
  const facade = facadeSwapped
    ? "const configuredEnv: Env = { ...env, CORE_DB: env.SEARCH_DB, SEARCH_DB: env.CORE_DB };"
    : facadeMutation
      ? "const configuredEnv: Env = env; configuredEnv.CORE_DB = configuredEnv.SEARCH_DB;"
      : facadeEscaped
        ? "const configuredEnv: Env = env; unknownSink(configuredEnv);"
        : "const configuredEnv: Env = env;";
  const projectionFactory = mcpProjection === "spread"
    ? "return { ...source };"
    : mcpProjection === "swapped"
      ? "return { CORE_DB: source.SEARCH_DB, SEARCH_DB: source.CORE_DB };"
      : mcpProjection === "call"
        ? "return { CORE_DB: identity(source.CORE_DB), SEARCH_DB: source.SEARCH_DB };"
        : "return { CORE_DB: source.CORE_DB, SEARCH_DB: source.SEARCH_DB };";
  const projectionActual = mcpProjection === "alias" ? "envAlias"
    : mcpProjection === "cast" ? "env as Env" : "env";
  const projectionPrelude = mcpProjection === "alias" ? "const envAlias = env;" : "";
  const projectionCall = mcpProjection === "none" ? "" :
    `if (request === "mcp") { const mcpEnv = projectWorkspaceMcpEnvironment(${projectionActual}); workspaceMcpRuntime(mcpEnv); }`;
  const sources = new Map([
    [paths.env, `export interface D1PreparedStatement { bind(...values: unknown[]): D1PreparedStatement; first(): unknown; run(): unknown }\nexport interface D1Database { prepare(sql: string): D1PreparedStatement }\nexport interface Env { readonly CORE_DB: D1Database; readonly SEARCH_DB: D1Database }\nexport interface ExportedHandler<E> { fetch(request: unknown, env: E, executionContext: unknown): unknown }`],
    [paths.worker, `import type { Env, ExportedHandler } from './env.js';\nimport { handleHttp } from './http.js';\nimport { projectWorkspaceMcpEnvironment, type WorkspaceMcpEnvironmentProjection } from '../../../packages/cloudflare-workspace-mcp/src/workspace-mcp-env.js';\nfunction workspaceMcpRuntime(view: WorkspaceMcpEnvironmentProjection): unknown { view.CORE_DB = view.SEARCH_DB; return view; }\nexport default { fetch(request: unknown, env: Env, executionContext: unknown): unknown { ${projectionPrelude} ${projectionCall} return handleHttp(request, env, executionContext); } } satisfies ExportedHandler<Env>;`],
    [paths.http, `import type { Env } from './env.js'; import { createApplication } from './composition-root.js'; interface HttpDependencies { readonly applicationFactory?: typeof createApplication } export function handleHttp(request: unknown, env: Env, executionContext: unknown, dependencies: HttpDependencies = {}): unknown { const factory = dependencies.applicationFactory ?? createApplication; return factory({ env, executionContext }); }`],
    [paths.composition, `import type { Env } from './env.js';\nimport { createErasureOwnerService } from './erasure-owner-service.js';\nfunction unknownSink(value: unknown): void { void value; }\nfunction ownerApi(env: Env): unknown { ${facade} return { erase: () => createErasureOwnerService({ env: configuredEnv }) }; }\nexport function createApplication(input: { readonly env: Env; readonly executionContext: unknown }): unknown { return ownerApi(input.env); }`],
    [paths.ownerService, `import type { Env } from './env.js';\nimport { createConfiguredErasureCoordinator } from './erasure-runtime.js';\nexport function createErasureOwnerService(input: { readonly env: Env }): unknown { return createConfiguredErasureCoordinator(input.env); }`],
    [paths.appRuntime, `import type { Env } from './env.js';\nimport { createConfiguredErasureCoordinator as inLibrary } from '../../../packages/cloudflare-erasure-operations/src/erasure-runtime.js';\nexport function createConfiguredErasureCoordinator(env: Env): unknown { return inLibrary({ core_database: env.CORE_DB, search_database: env.SEARCH_DB }); }`],
    [paths.operations, `${d1TypeImport}\nimport { createConfiguredErasureBackend } from '../../cloudflare-erasure/src/factory.js';\nexport interface ErasureConfiguredCoordinatorDependencies { readonly core_database: D1Database; readonly search_database: D1Database }\nexport function createConfiguredErasureCoordinator(dependencies: ErasureConfiguredCoordinatorDependencies): unknown { const configuredDependencies = { ...dependencies }; return createConfiguredErasureBackend(configuredDependencies); }`],
    [paths.factory, `${d1TypeImport}\nimport { createD1CoreErasureLocationPort } from './core-location.js';\nimport { createD1SearchErasureLocationPort } from './search-location.js';\nexport function createConfiguredErasureBackend(dependencies: { readonly core_database: D1Database; readonly search_database: D1Database }): unknown { createD1CoreErasureLocationPort({ database: ${coreArgument} }); createD1SearchErasureLocationPort({ database: ${searchArgument} }); return {}; }${conflictingCaller ? `\nexport function outsideCapability(database: D1Database): void { createD1CoreErasureLocationPort({ database }); }` : ""}`],
    [paths.core, `${d1TypeImport}\nexport function createD1CoreErasureLocationPort(dependencies: { readonly database: D1Database }): void { const database = dependencies.database; database.prepare('SELECT 1 FROM core_fixture').first(); }`],
    [paths.search, `${d1TypeImport}\nexport function createD1SearchErasureLocationPort(dependencies: { readonly database: D1Database }): void { const database = dependencies.database; database.prepare('SELECT 1 FROM search_fixture').first(); }`],
    [paths.projection, `import type { Env, D1Database } from '../../../apps/eliotr-core/src/env.js';\nexport interface WorkspaceMcpEnvironmentProjection { CORE_DB: D1Database; SEARCH_DB: D1Database }\nfunction identity<T>(value: T): T { return value; }\nexport function projectWorkspaceMcpEnvironment(source: Env): WorkspaceMcpEnvironmentProjection { ${projectionFactory} }`],
  ]);
  const options = {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const virtual = new Map([...sources].map(([path, text]) => [path.replaceAll("\\", "/").toLowerCase(), text]));
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (path) => virtual.has(resolve(path).replaceAll("\\", "/").toLowerCase()) || originalFileExists(path);
  host.readFile = (path) => virtual.get(resolve(path).replaceAll("\\", "/").toLowerCase()) ?? originalReadFile(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = virtual.get(resolve(path).replaceAll("\\", "/").toLowerCase());
    return text === undefined ? originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(path, text, languageVersion, true);
  };
  const files = [...sources.keys()];
  const program = ts.createProgram(files, options, host);
  const overrides = createErasureReceiverTargetOverrides(files, projectRoot, program);
  const coreQueries = extractSourceText(sources.get(paths.core), paths.core, overrides.get(paths.core.replaceAll("\\", "/").toLowerCase())).queries;
  const searchQueries = extractSourceText(sources.get(paths.search), paths.search, overrides.get(paths.search.replaceAll("\\", "/").toLowerCase())).queries;
  return {
    core: coreQueries.find((query) => query.sql === "SELECT 1 FROM core_fixture"),
    search: searchQueries.find((query) => query.sql === "SELECT 1 FROM search_fixture"),
  };
};

const typedTargets = typedD1Fixture();
assert.equal(typedTargets.core.targetStore, "core");
assert.equal(typedTargets.core.targetStatus, "resolved-local-const-alias");
assert.equal(typedTargets.search.targetStore, "search");
assert.equal(typedTargets.search.targetStatus, "resolved-local-const-alias");
const swappedTargets = typedD1Fixture({ swapped: true });
assert.equal(swappedTargets.core.targetStore, "search", "a Core factory receiving Search retains Search provenance");
assert.equal(swappedTargets.search.targetStore, "core", "a Search factory receiving Core retains Core provenance");
const conflictingTargets = typedD1Fixture({ conflictingCaller: true });
assert.equal(conflictingTargets.core.targetStore, "unknown", "an out-of-capability caller makes the shared Core receiver unknown");
assert.equal(conflictingTargets.search.targetStore, "search");
const facadeTargets = typedD1Fixture({ facadeSwapped: true });
assert.equal(facadeTargets.core.targetStore, "search", "an Env-typed swapped facade keeps actual Search provenance");
assert.equal(facadeTargets.search.targetStore, "core", "an Env-typed swapped facade keeps actual Core provenance");
const mutatedFacadeTargets = typedD1Fixture({ facadeMutation: true });
assert.equal(mutatedFacadeTargets.core.targetStore, "unknown", "mutating an Env alias invalidates that binding");
assert.equal(mutatedFacadeTargets.search.targetStore, "unknown", "a moved store handle is escaped through the mutated facade");
const escapedFacadeTargets = typedD1Fixture({ facadeEscaped: true });
assert.equal(escapedFacadeTargets.core.targetStore, "unknown", "an Env passed to an unqualified sink is escaped");
assert.equal(escapedFacadeTargets.search.targetStore, "unknown");
const detachedMcpProjectionTargets = typedD1Fixture({ mcpProjection: "valid" });
assert.equal(detachedMcpProjectionTargets.core.targetStore, "core",
  "a verified detached MCP view mutation does not poison the original HTTP Core binding");
assert.equal(detachedMcpProjectionTargets.search.targetStore, "search",
  "a verified detached MCP view mutation does not poison the original HTTP Search binding");
for (const mcpProjection of ["spread", "swapped", "call", "alias", "cast"]) {
  const unresolvedProjectionTargets = typedD1Fixture({ mcpProjection });
  assert.equal(unresolvedProjectionTargets.core.targetStore, "unknown", `${mcpProjection} MCP projection is unresolved`);
  assert.equal(unresolvedProjectionTargets.search.targetStore, "unknown", `${mcpProjection} MCP projection is unresolved`);
}

function validateCompilerEntries(entries) {
  const checker = fileURLToPath(new URL("./check-expression-depth.py", import.meta.url));
  const python = [
    "import json, runpy, sys",
    "validate = runpy.run_path(sys.argv[1])['valid_application_sql_entry']",
    "entries = json.load(sys.stdin)",
    "print(json.dumps([validate(item['entry'], unresolved=item['unresolved']) for item in entries]))",
  ].join("\n");
  const candidates = process.platform === "win32"
    ? [["python", []], ["py", ["-3"]], ["python3", []]]
    : [["python3", []], ["python", []]];
  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [...prefix, "-c", python, checker], {
      input: JSON.stringify(entries), encoding: "utf8", shell: false, timeout: 10_000, windowsHide: true,
    });
    if (result.error?.code === "ENOENT") continue;
    assert.equal(result.error, undefined, "Python manifest validator must start");
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  assert.fail("Python >=3.11 is required to validate the D1 inventory contract");
}

const directCore = targetBySql.get("SELECT 1 FROM direct_core");
const directSearch = targetBySql.get("SELECT 1 FROM direct_search");
const aliasCore = targetBySql.get("SELECT 1 FROM core_alias");
const aliasSearch = targetBySql.get("SELECT 1 FROM search_alias");
const unresolvedTarget = {
  ...directCore,
  location: "fixture.ts:200",
  receiver: "database",
  targetStore: "unknown",
  targetStatus: "unresolved-receiver",
};
const unresolvedSql = {
  ...aliasCore,
  location: "fixture.ts:201",
  bindingArity: null,
  bindingProvenance: "indirect-or-unknown",
  classification: "dynamic-or-unresolved-sql",
  reason: "dynamic-or-unresolved",
};
const invalidBindings = [
  { ...directCore, targetStatus: "unresolved-receiver" },
  { ...aliasCore, targetStore: "unknown", targetStatus: "resolved-local-const-alias" },
  { ...aliasSearch, targetStatus: "resolved-callsite-alias" },
  { ...directCore, bindingProvenance: "guessed-core" },
];
assert.deepEqual(validateCompilerEntries([
  { entry: directCore, unresolved: false },
  { entry: directSearch, unresolved: false },
  { entry: aliasCore, unresolved: false },
  { entry: aliasSearch, unresolved: false },
  { entry: unresolvedTarget, unresolved: false },
  { entry: unresolvedSql, unresolved: true },
  ...invalidBindings.map((entry) => ({ entry, unresolved: false })),
]), [true, true, true, true, true, true, false, false, false, false]);

process.stdout.write("D1_APP_SQL extractor fixtures PASS\n");
