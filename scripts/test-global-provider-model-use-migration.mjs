import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const directory = new URL("../infra/d1/core/migrations/", import.meta.url);
const migration = readFileSync(new URL("0156_global_provider_model_use.sql", directory), "utf8");
const root = "research_provider_key_model_use_operation";
const stages = "research_provider_key_model_use_stage_operation";
const prices = "research_provider_key_model_price_observation";
const model = "dots-studio/dots-3-note-preview:free";
const legacyModel = "stealth/space-bunny-alpha";
const sha = "a".repeat(64);
const alias = "eliotr-" + "b".repeat(48);
const created = "2026-10-16T00:00:00.000Z";
const deadline = "2099-01-01T00:00:00.000Z";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function migrate(db, sql) {
  db.exec("BEGIN");
  try { db.exec(sql); db.exec("COMMIT"); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function baseline() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(directory).filter((file) => /^\d{4}_.*\.sql$/u.test(file)).sort()) {
    const number = Number(file.slice(0, 4));
    if (number >= 141 && number <= 151) throw new Error("Canceled migration must never run: " + file);
    if (number >= 156) continue;
    migrate(db, readFileSync(new URL(file, directory), "utf8"));
  }
  return db;
}
function insert(db, table, row) {
  const keys = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row));
}
function project(db, id, owner) {
  insert(db, "project", { project_id: id, title: "SQLite fixture", default_disclosure: "private", retention_policy_ref: "retention",
    default_source_policy_ref: "source", default_model_profile_ref: "profile", default_depth_profile_ref: "depth", generation: 1, created_at: created });
  insert(db, "project_owner", { project_id: id, principal_ref: owner, deployment_generation: "deployment", created_at: created, updated_at: created });
}
function legacyKey(db, owner, projectId, key, overrides = {}) {
  insert(db, "research_provider_key_configuration_operation", { owner_id: owner, project_id: projectId, provider_id: "openrouter", operation_id: key,
    account_id: "c".repeat(32), gateway_id: "eliotr-reasoning", request_sha256: sha, alias, state: "CONFIGURED", provider_config_id: "config",
    metadata_sha256: sha, failure_code: null, provider_http_status: null, created_at: created, updated_at: created, ...overrides });
}
function globalKey(db, owner, key, ids = [model]) {
  insert(db, "service_model_provider_operation", { owner_id: owner, operation_id: key, provider_id: "openrouter", display_name: "OpenRouter",
    base_url: null, model_ids_json: JSON.stringify(ids), request_sha256: sha, alias, state: "CONFIGURED", provider_config_id: "config",
    provider_slug: "openrouter", metadata_sha256: sha, failure_code: null, provider_http_status: null, created_at: created, updated_at: created });
}
function useRow(owner, projectId, key, exactModel = model) {
  return { owner_id: owner, project_id: projectId, provider_id: "openrouter", operation_id: randomUUID(), key_operation_id: key,
    account_id: "c".repeat(32), gateway_id: "eliotr-reasoning", alias, provider_config_id: "config", configuration_metadata_sha256: sha,
    request_sha256: sha, configuration_basis_json: JSON.stringify({ protocol: "eliotr.research.provider-key-model-use-basis.v1",
      stages: ["SYNTHESIZE", "AUDIT_CLAIMS"].map((stage) => ({ stage, transport_policy: {
        api: "openrouter-chat-completions", provider: "openrouter", model: exactModel, billing: { mode: "byok", alias, free_only: true },
      } })) }), owner_credential_generation: "credential", project_generation: 1, deployment_generation: "deployment", deadline_at: deadline,
    expected_selection_revision: null, source_configuration_ref: null, source_configuration_sha256: null, planned_stage_set_sha256: sha, plan_sha256: sha,
    state: "ACCEPTED", phase: "INTENT", active_stage: null, target_configuration_ref: null, target_configuration_sha256: null,
    target_configuration_json: null, selected_configuration_ref: null, selection_revision: null, failure_code: null, created_at: created, updated_at: created };
}
function stageRows(db, use) {
  for (const [sequence, stage] of ["SYNTHESIZE", "AUDIT_CLAIMS"].entries()) insert(db, stages, {
    owner_id: use.owner_id, project_id: use.project_id, operation_id: use.operation_id, sequence_number: sequence, stage,
    route_ref: stage === "SYNTHESIZE" ? "dynamic/eliotr-balanced" : "dynamic/eliotr-audit-verifier", route_version: "version-1",
    prompt_sha256: sha, schema_sha256: sha, parameters_sha256: sha, probe_prompt_sha256: sha, probe_schema_sha256: sha, probe_parameters_sha256: sha,
    pricing_snapshot_ref: null, pricing_snapshot_sha256: null, preparation_ref: null, preparation_sha256: null, candidate_ref: null,
    candidate_sha256: null, qualification_ref: null, qualification_sha256: null, state: "PENDING", failure_code: null, created_at: created, updated_at: created,
  });
  db.prepare(`UPDATE ${root} SET state='PREPARING',phase='FREE_PRICE_CHECK',active_stage='SYNTHESIZE' WHERE operation_id=?`).run(use.operation_id);
}
function priceRow(use, exactModel = model) {
  const bytes = Buffer.from(JSON.stringify({ data: { id: exactModel, endpoints: [{ model_id: exactModel, pricing: { prompt: "0", completion: "0" } }] } }));
  return { owner_id: use.owner_id, project_id: use.project_id, operation_id: use.operation_id, stage: "SYNTHESIZE", key_operation_id: use.key_operation_id,
    account_id: use.account_id, gateway_id: use.gateway_id, alias, provider_config_id: "config", configuration_metadata_sha256: sha,
    request_sha256: use.request_sha256, owner_credential_generation: "credential", project_generation: 1, deployment_generation: "deployment",
    route_ref: "dynamic/eliotr-balanced", route_version: "version-1", provider_id: "openrouter", exact_model_id: exactModel,
    source_url: `https://openrouter.ai/api/v1/models/${exactModel.split("/").map(encodeURIComponent).join("/")}/endpoints`,
    observation_ref: "price-" + randomUUID(), source_response_sha256: hash(bytes), response_base64: bytes.toString("base64"), byte_length: bytes.length,
    readback_sha256: hash(bytes), observed_at: created, expires_at: deadline, approval_receipt_ref: use.operation_id, created_at: created };
}
const db = baseline();
project(db, "legacy-project", "legacy-owner");
const key = randomUUID();
legacyKey(db, "legacy-owner", "legacy-project", key);
const legacy = useRow("legacy-owner", "legacy-project", key, legacyModel);
insert(db, root, legacy); stageRows(db, legacy); insert(db, prices, priceRow(legacy, legacyModel));
const tables = ["research_provider_key_configuration_operation", root, stages, prices];
const snapshot = () => tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1,2,3`).all());
const before = snapshot();
const childFks = db.prepare(`PRAGMA foreign_key_list(${stages})`).all();
const oldTriggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
const oldTables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
migrate(db, migration);
assert.deepEqual(snapshot(), before, "all legacy bytes, hashes and child receipts survive the parent swaps");
assert.deepEqual(db.prepare(`PRAGMA foreign_key_list(${stages})`).all(), childFks);
assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all(), oldTables);
for (const trigger of oldTriggers) {
  const expected = trigger.sql.includes(root) || trigger.sql.includes(prices)
    ? trigger.sql.replaceAll("research_provider_key_configuration_operation k", "research_provider_key_model_use_key_authority k") : trigger.sql;
  assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(trigger.name)?.sql, expected,
    "retain every existing proof/currentness/zero-price/immutability trigger: " + trigger.name);
}
assert.throws(() => db.prepare(`UPDATE ${root} SET configuration_basis_json='{}' WHERE operation_id=?`).run(legacy.operation_id), /immutable/u);
assert.throws(() => db.prepare("DELETE FROM research_provider_key_configuration_operation WHERE operation_id=?").run(key), /immutable/u);

project(db, "global-project", "global-owner");
const globalId = randomUUID(); globalKey(db, "global-owner", globalId);
const accepted = useRow("global-owner", "global-project", globalId);
insert(db, root, accepted); stageRows(db, accepted); insert(db, prices, priceRow(accepted));
assert.equal(db.prepare(`SELECT exact_model_id FROM ${prices} WHERE operation_id=?`).get(accepted.operation_id).exact_model_id, model);
assert.equal(db.prepare("SELECT count(*) AS n FROM research_provider_key_configuration_operation WHERE project_id='global-project'").get().n, 0);
assert.equal(db.prepare("SELECT model_ids_json FROM research_provider_key_model_use_key_authority WHERE project_id='global-project'").get().model_ids_json, JSON.stringify([model]));
assert.throws(() => insert(db, prices, { ...priceRow(accepted, legacyModel) }), /immutable exact model|current owner/u);
assert.throws(() => db.prepare("UPDATE service_model_provider_operation SET model_ids_json=? WHERE operation_id=?").run(JSON.stringify([legacyModel]), globalId), /immutable/u);
assert.throws(() => db.prepare("DELETE FROM service_model_provider_operation WHERE operation_id=?").run(globalId), /immutable/u);

project(db, "foreign-project", "foreign-owner");
assert.throws(() => insert(db, root, useRow("foreign-owner", "foreign-project", globalId)), /configured project or global/u);
project(db, "unregistered-project", "global-owner");
assert.throws(() => insert(db, root, useRow("global-owner", "unregistered-project", globalId, legacyModel)), /configured project or global/u);
project(db, "precedence-project", "global-owner");
legacyKey(db, "global-owner", "precedence-project", globalId, { alias: "eliotr-" + "d".repeat(48), state: "PENDING", provider_config_id: null, metadata_sha256: null });
assert.throws(() => insert(db, root, useRow("global-owner", "precedence-project", globalId)), /configured project or global/u);
assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

// Unknown cascading children cause an atomic failure before DROP; they cannot be erased.
const cascadeDb = baseline();
project(cascadeDb, "cascade-project", "cascade-owner");
const cascadeKey = randomUUID(); legacyKey(cascadeDb, "cascade-owner", "cascade-project", cascadeKey);
const cascadeUse = useRow("cascade-owner", "cascade-project", cascadeKey, legacyModel); insert(cascadeDb, root, cascadeUse);
cascadeDb.exec(`CREATE TABLE cascade_fixture(owner_id TEXT,project_id TEXT,operation_id TEXT, FOREIGN KEY(owner_id,project_id,operation_id) REFERENCES ${root}(owner_id,project_id,operation_id) ON DELETE CASCADE)`);
insert(cascadeDb, "cascade_fixture", { owner_id: cascadeUse.owner_id, project_id: cascadeUse.project_id, operation_id: cascadeUse.operation_id });
assert.throws(() => migrate(cascadeDb, migration), /CHECK constraint/u);
assert.equal(cascadeDb.prepare("SELECT count(*) AS n FROM cascade_fixture").get().n, 1);
assert.equal(cascadeDb.prepare(`SELECT count(*) AS n FROM ${root}`).get().n, 1);
db.close(); cascadeDb.close();
console.log("global provider model-use migration: PASS (legacy bytes/FKs, exact global Dots price, owner/model/precedence negatives, immutable targets, cascade rollback)");
