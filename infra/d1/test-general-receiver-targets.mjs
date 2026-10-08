import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { normalized } from "./receiver-target-provenance-values.mjs";
import { discoverConfiguredReceiverRoots } from "./receiver-target-general-roots.mjs";
import { traceConfiguredReceiverTargets } from "./receiver-target-general-flow.mjs";

function analyze(source, rootNames) {
  const directory = mkdtempSync(join(tmpdir(), "issue294-general-"));
  const file = resolve(directory, "fixture.ts");
  writeFileSync(file, source, "utf8");
  const program = ts.createProgram([file], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022 });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(file);
  const envDeclaration = sourceFile.statements.find((item) => ts.isInterfaceDeclaration(item) && item.name.text === "Env");
  const envSymbol = checker.getSymbolAtLocation(envDeclaration.name);
  const envType = checker.getDeclaredTypeOfSymbol(envSymbol);
  const core = checker.getPropertyOfType(envType, "CORE_DB");
  const search = checker.getPropertyOfType(envType, "SEARCH_DB");
  const d1Type = checker.getTypeOfSymbolAtLocation(core, core.valueDeclaration);
  const prepare = checker.getPropertyOfType(d1Type, "prepare");
  const declarations = new Set(prepare.declarations);
  const roots = rootNames.map((name) => {
    const declaration = sourceFile.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === name);
    return {
      kind: "worker",
      declaration,
      envSymbol,
      bindings: new Map([[core, "core"], [search, "search"]]),
    };
  });
  let sink;
  function find(node) {
    if (!sink && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "prepare") sink = node;
    ts.forEachChild(node, find);
  }
  find(sourceFile);
  const trace = traceConfiguredReceiverTargets({
    program,
    checker,
    roots,
    nativePrepareDeclarations: declarations,
    rootFiles: [file],
    eligibleSource: (path) => path === normalized(file),
  });
  const overrides = trace.overrides.get(normalized(file));
  return {
    trace,
    sinkTarget: overrides?.get(sink?.getStart(sourceFile))?.targetStore,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function writeProjectFile(root, relativePath, contents) {
  const path = resolve(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
  return path;
}

function analyzeConfiguredProject({ queueSource, fetchSource, projectionSource, augmentation }) {
  const root = mkdtempSync(join(tmpdir(), "issue294-configured-"));
  writeProjectFile(root, "node_modules/@cloudflare/workers-types/package.json", '{"types":"index.d.ts"}');
  writeProjectFile(root, "node_modules/@cloudflare/workers-types/index.d.ts", [
    "export interface D1DatabaseSession { prepare(query: string): unknown; }",
    "export interface D1Database { prepare(query: string): unknown; }",
    "export interface ExportedHandler<Environment> {",
    "  fetch?: (request: unknown, env: Environment, context: unknown) => unknown;",
    "  queue?: (batch: unknown, env: Environment, context: unknown) => unknown;",
    "}",
  ].join("\n"));
  writeProjectFile(root, "apps/eliotr-core/src/env.ts", [
    'import type { D1Database } from "@cloudflare/workers-types";',
    "export interface Env { CORE_DB: D1Database; SEARCH_DB: D1Database; }",
  ].join("\n"));
  writeProjectFile(root, "apps/eliotr-core/src/index.ts", [
    'import type { Env } from "./env";',
    'import type { ExportedHandler } from "@cloudflare/workers-types";',
    'import { handleQueue } from "./queue";',
    'import { runSearch } from "../../../packages/cloudflare-projection/src/d1-search";',
    "export default {",
    "  fetch(request: unknown, env: Env, context: unknown) { FETCH_BODY },",
    "  queue(batch: unknown, env: Env, context: unknown) { return handleQueue(env); },",
    "} satisfies ExportedHandler<Env>;",
  ].join("\n").replace("FETCH_BODY", fetchSource));
  writeProjectFile(root, "apps/eliotr-core/src/queue.ts", [
    'import type { Env } from "./env";',
    'import { consume, createSearchPort, runSearch } from "../../../packages/cloudflare-projection/src/d1-search";',
    "export function handleQueue(env: Env) {",
    queueSource,
    "}",
  ].join("\n"));
  const extraProjection = [
    ...(projectionSource.includes("export function runSearch(") ? [] : [
      "export function runSearch(database: D1Database) { return database.prepare('SELECT 1'); }",
    ]),
    ...(projectionSource.includes("export declare function consume(") ? [] : [
      "export declare function consume(callback: () => unknown): unknown;",
    ]),
  ];
  const projectionPath = writeProjectFile(root, "packages/cloudflare-projection/src/d1-search.ts", [
    'import type { D1Database } from "@cloudflare/workers-types";',
    projectionSource,
    ...extraProjection,
  ].join("\n"));
  writeProjectFile(root, "apps/eliotr-core/wrangler.jsonc", JSON.stringify({
    main: "./src/index.ts",
    d1_databases: [
      { binding: "CORE_DB", database_name: "core-fixture", migrations_dir: "../../infra/d1/core/migrations" },
      { binding: "SEARCH_DB", database_name: "search-fixture", migrations_dir: "../../infra/d1/search/migrations" },
    ],
    queues: { consumers: [{ queue: "fixture" }] },
  }));
  writeProjectFile(root, "infra/d1/core/migrations/.keep", "");
  writeProjectFile(root, "infra/d1/search/migrations/.keep", "");
  const augmentationPath = augmentation
    ? writeProjectFile(root, "apps/eliotr-core/src/workers-type-augmentation.d.ts", augmentation) : undefined;
  const workerPath = resolve(root, "apps/eliotr-core/src/index.ts");
  const program = ts.createProgram({
    rootNames: [workerPath, ...(augmentationPath ? [augmentationPath] : [])],
    options: {
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      types: ["@cloudflare/workers-types"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const checker = program.getTypeChecker();
  const roots = discoverConfiguredReceiverRoots({ root, program, checker });
  const rootFiles = program.getSourceFiles().filter((source) => !source.isDeclarationFile
    && normalized(source.fileName).startsWith(`${normalized(root)}/`)).map((source) => source.fileName);
  const trace = roots.complete ? traceConfiguredReceiverTargets({
    program,
    checker,
    roots: roots.roots,
    nativePrepareDeclarations: roots.nativePrepareDeclarations,
    rootFiles,
    eligibleSource: (path) => path === normalized(projectionPath),
  }) : { complete: false, overrides: new Map(), reason: roots.reason };
  const projection = program.getSourceFile(projectionPath);
  let sink;
  function findSink(node) {
    if (!sink && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "prepare") sink = node;
    ts.forEachChild(node, findSink);
  }
  if (projection) findSink(projection);
  const target = trace.overrides.get(normalized(projectionPath))?.get(sink?.getStart(projection))?.targetStore;
  return {
    roots,
    trace,
    target,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

const definitions = [
  "interface D1Database { prepare(sql: string): unknown; }",
  "interface Env { CORE_DB: D1Database; SEARCH_DB: D1Database; }",
].join("\n");

test("queue-rooted direct and const/object forwarding preserves the actual target", () => {
  const source = [definitions,
    "function sink(input: { database: D1Database }) { input.database.prepare('select 1'); }",
    "function queue(batch: unknown, env: Env) { const bindings = { database: env.SEARCH_DB }; sink(bindings); }",
  ].join("\n");
  const result = analyze(source, ["queue"]);
  try {
    assert.equal(result.sinkTarget, "search");
    assert.equal(result.trace.complete, true);
  } finally { result.dispose(); }
});

test("swapped property values report their source binding, not the field label", () => {
  const source = [definitions,
    "function sink(input: { core_database: D1Database }) { input.core_database.prepare('select 1'); }",
    "function queue(batch: unknown, env: Env) { sink({ core_database: env.SEARCH_DB }); }",
  ].join("\n");
  const result = analyze(source, ["queue"]);
  try {
    assert.equal(result.sinkTarget, "search");
  } finally { result.dispose(); }
});

test("conflicting configured roots and mutable aliases remain unresolved", () => {
  const conflicting = [definitions,
    "function sink(database: D1Database) { database.prepare('select 1'); }",
    "function queue(batch: unknown, env: Env) { sink(env.SEARCH_DB); }",
    "function scheduled(event: unknown, env: Env) { sink(env.CORE_DB); }",
  ].join("\n");
  const conflictResult = analyze(conflicting, ["queue", "scheduled"]);
  try { assert.equal(conflictResult.sinkTarget, undefined); } finally { conflictResult.dispose(); }

  const mutated = [definitions,
    "function sink(database: D1Database) { database.prepare('select 1'); }",
    "function queue(batch: unknown, env: Env) { let database = env.SEARCH_DB; database = env.CORE_DB; sink(database); }",
  ].join("\n");
  const mutationResult = analyze(mutated, ["queue"]);
  try { assert.equal(mutationResult.sinkTarget, undefined); } finally { mutationResult.dispose(); }
});

test("opaque callback forwarding and dynamic Env mutation fail closed", () => {
  const callback = [definitions,
    "declare function consume(callback: () => void): void;",
    "function queue(batch: unknown, env: Env) { const database = env.SEARCH_DB; consume(() => database.prepare('select 1')); }",
  ].join("\n");
  const callbackResult = analyze(callback, ["queue"]);
  try { assert.equal(callbackResult.sinkTarget, undefined); } finally { callbackResult.dispose(); }

  const dynamic = [definitions,
    "function sink(database: D1Database) { database.prepare('select 1'); }",
    "function queue(batch: unknown, env: Env) { const key: keyof Env = 'CORE_DB'; env[key] = env.SEARCH_DB; sink(env.CORE_DB); }",
  ].join("\n");
  const dynamicResult = analyze(dynamic, ["queue"]);
  try { assert.equal(dynamicResult.sinkTarget, undefined); } finally { dynamicResult.dispose(); }
});

test("returned method and known callback preserve the captured database origin", () => {
  const source = [definitions,
    "function createPort(database: D1Database) { return { activate() { database.prepare('select 1'); } }; }",
    "function execute(activate: () => void) { activate(); }",
    "function queue(batch: unknown, env: Env) { const port = createPort(env.CORE_DB); execute(port.activate); }",
  ].join("\n");
  const result = analyze(source, ["queue"]);
  try { assert.equal(result.sinkTarget, "core"); } finally { result.dispose(); }
});

test("spread and computed projections do not preserve target proof", () => {
  const spread = [definitions,
    "function sink(input: { database: D1Database }) { input.database.prepare('select 1'); }",
    "function queue(batch: unknown, env: Env) { const base = { database: env.SEARCH_DB }; sink({ ...base }); }",
  ].join("\n");
  const spreadResult = analyze(spread, ["queue"]);
  try { assert.equal(spreadResult.sinkTarget, undefined); } finally { spreadResult.dispose(); }

  const computed = [definitions,
    "function sink(input: { database: D1Database }) { input.database.prepare('select 1'); }",
    "function queue(batch: unknown, env: Env) { const name: string = 'database'; sink({ [name]: env.SEARCH_DB } as { database: D1Database }); }",
  ].join("\n");
  const computedResult = analyze(computed, ["queue"]);
  try { assert.equal(computedResult.sinkTarget, undefined); } finally { computedResult.dispose(); }
});

test("configured Wrangler queue root reaches canonical D1 through the Search projection port", () => {
  const result = analyzeConfiguredProject({
    fetchSource: "return new Response();",
    queueSource: "const port = createSearchPort({ search: env.SEARCH_DB }); return port.activate();",
    projectionSource: [
      "export function createSearchPort(input: { search: D1Database }) {",
      "  return { activate() { return input.search.prepare('SELECT 1'); } };",
      "}",
    ].join("\n"),
  });
  try {
    assert.equal(result.roots.complete, true);
    assert.equal(result.roots.roots.some((root) => root.kind === "worker" && root.declaration.name?.getText() === "queue"), true);
    assert.equal(result.target, "search");
  } finally { result.dispose(); }
});

test("configured callers that disagree on the same D1 sink cannot inherit one target", () => {
  const result = analyzeConfiguredProject({
    fetchSource: "return runSearch(env.CORE_DB);",
    queueSource: "return runSearch(env.SEARCH_DB);",
    projectionSource: "export function runSearch(database: D1Database) { return database.prepare('SELECT 1'); }",
  });
  try {
    assert.equal(result.roots.complete, true);
    assert.equal(result.target, undefined);
  } finally { result.dispose(); }
});

test("configured object-property mutation cannot preserve its initializer target", () => {
  const result = analyzeConfiguredProject({
    fetchSource: "return new Response();",
    queueSource: [
      "const dependencies = { search: env.SEARCH_DB };",
      "dependencies.search = env.CORE_DB;",
      "const port = createSearchPort(dependencies); return port.activate();",
    ].join("\n"),
    projectionSource: [
      "export function createSearchPort(input: { search: D1Database }) {",
      "  return { activate() { return input.search.prepare('SELECT 1'); } };",
      "}",
    ].join("\n"),
  });
  try {
    assert.equal(result.roots.complete, true);
    assert.equal(result.target, undefined);
  } finally { result.dispose(); }
});

test("configured aliased, computed, compound, deleted, and prepare writes fail closed", () => {
  const cases = [
    {
      label: "aliased-property-write",
      queueSource: [
        "const dependencies = { search: env.SEARCH_DB };",
        "const alias = dependencies; alias.search = env.CORE_DB;",
        "return createSearchPort(dependencies).activate();",
      ].join("\n"),
      projectionSource: [
        "export function createSearchPort(input: { search: D1Database }) {",
        "  return { activate() { return input.search.prepare('SELECT 1'); } };",
        "}",
      ].join("\n"),
    },
    {
      label: "computed-property-write",
      queueSource: [
        "const dependencies = { search: env.SEARCH_DB };",
        "const key: string = 'search'; dependencies[key] = env.CORE_DB;",
        "return createSearchPort(dependencies).activate();",
      ].join("\n"),
      projectionSource: [
        "export function createSearchPort(input: { search: D1Database }) {",
        "  return { activate() { return input.search.prepare('SELECT 1'); } };",
        "}",
      ].join("\n"),
    },
    {
      label: "compound-property-write",
      queueSource: [
        "const dependencies = { search: env.SEARCH_DB };",
        "dependencies.search ||= env.CORE_DB;",
        "return createSearchPort(dependencies).activate();",
      ].join("\n"),
      projectionSource: [
        "export function createSearchPort(input: { search: D1Database }) {",
        "  return { activate() { return input.search.prepare('SELECT 1'); } };",
        "}",
      ].join("\n"),
    },
    {
      label: "delete-optional-property",
      queueSource: [
        "const dependencies: { search?: D1Database } = { search: env.SEARCH_DB };",
        "delete dependencies.search;",
        "return createSearchPort(dependencies).activate();",
      ].join("\n"),
      projectionSource: [
        "export function createSearchPort(input: { search?: D1Database }) {",
        "  return { activate() { return input.search ? input.search.prepare('SELECT 1') : undefined; } };",
        "}",
      ].join("\n"),
    },
    {
      label: "parenthesized-delete-optional-property",
      queueSource: [
        "const dependencies: { search?: D1Database } = { search: env.SEARCH_DB };",
        "delete (dependencies.search);",
        "return createSearchPort(dependencies).activate();",
      ].join("\n"),
      projectionSource: [
        "export function createSearchPort(input: { search?: D1Database }) {",
        "  return { activate() { return input.search ? input.search.prepare('SELECT 1') : undefined; } };",
        "}",
      ].join("\n"),
    },
    {
      label: "native-prepare-replacement",
      expectedReason: "native-prepare-replacement",
      queueSource: "return replacePrepare(env.SEARCH_DB);",
      projectionSource: [
        "export function replacePrepare(database: D1Database) {",
        "  database.prepare = (query: string) => 'forged';",
        "  return database.prepare('SELECT 1');",
        "}",
      ].join("\n"),
    },
    {
      label: "parenthesized-native-prepare-replacement",
      expectedReason: "native-prepare-replacement",
      queueSource: "return replacePrepare(env.SEARCH_DB);",
      projectionSource: [
        "export function replacePrepare(database: D1Database) {",
        "  ((database.prepare)) = (query: string) => 'forged';",
        "  return database.prepare('SELECT 1');",
        "}",
      ].join("\n"),
    },
  ];
  for (const scenario of cases) {
    const { label, expectedReason, ...scenarioInput } = scenario;
    const result = analyzeConfiguredProject({ fetchSource: "return new Response();", ...scenarioInput });
    try {
      assert.equal(result.roots.complete, true, `${label}: configured roots`);
      assert.equal(result.target, undefined, `${label}: target remains unknown`);
      if (expectedReason) {
        assert.equal(result.trace.complete, false, `${label}: trace must fail closed`);
        assert.equal(result.trace.reason, expectedReason, `${label}: incomplete reason`);
      }
    } finally { result.dispose(); }
  }
});

test("configured native D1 identity rejects a noncanonical prepare augmentation", () => {
  const result = analyzeConfiguredProject({
    fetchSource: "return new Response();",
    queueSource: "return runSearch(env.SEARCH_DB);",
    projectionSource: "export function runSearch(database: D1Database) { return database.prepare('SELECT 1'); }",
    augmentation: [
      'import "@cloudflare/workers-types";',
      'declare module "@cloudflare/workers-types" {',
      '  interface D1Database { prepare(query: "forged"): unknown; }',
      "}",
    ].join("\n"),
  });
  try {
    assert.equal(result.roots.complete, false);
    assert.equal(result.target, undefined);
  } finally { result.dispose(); }
});

test("configured opaque callback capture of a D1 receiver remains unresolved", () => {
  const result = analyzeConfiguredProject({
    fetchSource: "return new Response();",
    queueSource: [
      "const port = createSearchPort({ search: env.SEARCH_DB });",
      "return consume(() => port.activate());",
    ].join("\n"),
    projectionSource: [
      "declare function consume(callback: () => unknown): unknown;",
      "export function createSearchPort(input: { search: D1Database }) {",
      "  return { activate() { return input.search.prepare('SELECT 1'); } };",
      "}",
    ].join("\n"),
  });
  try {
    assert.equal(result.roots.complete, true);
    assert.equal(result.target, undefined);
  } finally { result.dispose(); }
});

test("configured nested destructuring and loop assignment targets abort general tracing", () => {
  const queueSources = [
    [
      "const dependencies = { search: env.SEARCH_DB };",
      "({ nested: { search: dependencies.search } = { search: env.CORE_DB } } = {});",
      "return createSearchPort(dependencies).activate();",
    ].join("\n"),
    [
      "const dependencies = { search: env.SEARCH_DB };",
      "[dependencies.search = env.CORE_DB] = [];",
      "return createSearchPort(dependencies).activate();",
    ].join("\n"),
    [
      "const dependencies = { search: env.SEARCH_DB };",
      "for ({ search: dependencies.search } of [{ search: env.CORE_DB }]) {}",
      "return createSearchPort(dependencies).activate();",
    ].join("\n"),
    [
      "const dependencies = { search: env.SEARCH_DB };",
      "for (dependencies.search of [env.CORE_DB]) {}",
      "return createSearchPort(dependencies).activate();",
    ].join("\n"),
  ];
  for (const queueSource of queueSources) {
    const result = analyzeConfiguredProject({
      fetchSource: "return new Response();",
      queueSource,
      projectionSource: [
        "export function createSearchPort(input: { search: D1Database }) {",
        "  return { activate() { return input.search.prepare('SELECT 1'); } };",
        "}",
      ].join("\n"),
    });
    try {
      assert.equal(result.roots.complete, true);
      assert.equal(result.target, undefined);
      assert.equal(result.trace.complete, false);
    } finally { result.dispose(); }
  }
});
