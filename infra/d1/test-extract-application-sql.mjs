import process from "node:process";
import assert from "node:assert/strict";
import { extractSourceText } from "./extract-application-sql.mjs";

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

process.stdout.write("D1_APP_SQL extractor fixtures PASS\n");
