/// <reference types="node" />
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

const migrations = fileURLToPath(new URL("../../../infra/d1/core/migrations/", import.meta.url));
const source = (name: string) => readFileSync(`${migrations}/${name}`, "utf8");
const previous = source("0105_research_pinned_model_authority.sql");
const replacement = source("0163_research_native_model_spend_authority.sql");
const admissionDdl = source("0096_research_model_spend_admission_branch_stages.sql");
const bindingDdl = source("0139_research_branch_role_workflow_binding.sql");
const prerequisite = "1a0624d150fe10dc19bcdffbaba21c62adabf917f686a7043985e82448290e31";
const opened: DatabaseSync[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

function trigger(sql: string, name: string): string {
  const found = sql.match(new RegExp(`CREATE TRIGGER ${name}\\b[\\s\\S]*?\\nEND;`));
  if (found === null) throw new Error(`Missing production trigger ${name}`);
  return found[0];
}
function insert(db: DatabaseSync, table: string, row: Record<string, SQLInputValue>) {
  const columns = Object.keys(row);
  return db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...Object.values(row));
}
const sha = "a".repeat(64), otherSha = "b".repeat(64);
const future = "2099-01-01T00:00:00.000Z", past = "2000-01-01T00:00:00.000Z";
const deployment = { route_ref: "dynamic/eliotr-balanced", route_version: "native-v1", prompt_generation: "prompt-1",
  schema_generation: "schema-1", parameters_digest: sha, pricing_snapshot_ref: "pricing-1" };
const transport = { version: 1, transport: "cloudflare-ai-gateway", api: "custom-chat-completions", provider: "custom-opencode-go",
  model: "muse-spark-1.3-contributor", billing: { mode: "byok", alias: `eliotr-${"c".repeat(48)}` },
  capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["high"] } };
type Family = "dynamic-route" | "provider-native-v1" | "provider-native-v2";

// Ancestor readback tables are controlled fixtures. The admission table (with
// CHECK/FK constraints), shape/W2/immutability guards, original 0105 guard and
// replacement migration are loaded verbatim. Every case executes a real INSERT,
// not an extracted authority predicate. Full-schema installation is checked below.
function fixture(family: Family = "provider-native-v2", stageIndex = 12, migrate = true) {
  const db = new DatabaseSync(":memory:"); opened.push(db);
  const selectedTransport = family === "provider-native-v1" ? { ...transport, api: "openrouter-chat-completions",
    provider: "openrouter", model: "stealth/space-bunny-alpha:free", billing: { ...transport.billing, free_only: true } } : transport;
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE scope_snapshot(snapshot_id TEXT,revision INTEGER,PRIMARY KEY(snapshot_id,revision));
    CREATE TABLE research_workflow_run(operation_id TEXT PRIMARY KEY,investigation_id TEXT,principal_ref TEXT,
      credential_generation TEXT,deployment_generation TEXT,configuration_required INTEGER,configuration_ref TEXT,
      state TEXT,next_stage_index INTEGER,current_revision INTEGER,ledger_revision INTEGER,idempotency_key TEXT,
      handler_generation TEXT,policy_generation TEXT,policy_authority_ref TEXT,scope_snapshot_id TEXT,
      scope_snapshot_revision INTEGER,authorization_receipt_ref TEXT);
    CREATE VIEW research_workflow_current AS SELECT * FROM research_workflow_run;
    CREATE TABLE research_workflow_attempt(operation_id TEXT,stage_index INTEGER,attempt_ref TEXT UNIQUE,state TEXT,
      expected_revision INTEGER,request_sha256 TEXT,request_json TEXT,budget_receipt_ref TEXT,output_json TEXT,
      PRIMARY KEY(operation_id,stage_index));
    CREATE TABLE scope_access_grant(snapshot_id TEXT,snapshot_revision INTEGER,principal_ref TEXT,client_class TEXT,
      credential_generation TEXT,policy_authority_ref TEXT,authorization_receipt_ref TEXT,state TEXT,expires_at TEXT,allowed_use_json TEXT);
    CREATE TABLE research_run_configuration(operation_id TEXT,configuration_ref TEXT,investigation_id TEXT,
      principal_ref TEXT,deployment_generation TEXT,mode TEXT,configuration_json TEXT);
    CREATE TABLE dynamic_route_candidate(route_ref TEXT,route_version TEXT,candidate_ref TEXT,candidate_sha256 TEXT,candidate_json TEXT);
    CREATE TABLE dynamic_route_qualification_proof(route_ref TEXT,route_version TEXT,candidate_ref TEXT,candidate_sha256 TEXT,
      qualification_ref TEXT,proof_sha256 TEXT,qualification_json TEXT);
    CREATE TABLE dynamic_route_active_generation(route_ref TEXT,route_version TEXT,candidate_ref TEXT,candidate_sha256 TEXT);
    CREATE TABLE dynamic_route_active_qualification(route_ref TEXT,route_version TEXT,candidate_ref TEXT,candidate_sha256 TEXT,
      qualification_ref TEXT,qualification_sha256 TEXT);
    CREATE TABLE dynamic_route_qualification_revocation(qualification_ref TEXT,qualification_sha256 TEXT);
    CREATE TABLE provider_native_model_candidate(owner_ref TEXT,project_id TEXT,stage TEXT,route_ref TEXT,route_version TEXT,
      candidate_ref TEXT,candidate_sha256 TEXT,candidate_json TEXT,observation_ref TEXT,observation_sha256 TEXT,qualification_tier TEXT);
    CREATE TABLE provider_native_model_qualification_proof(owner_ref TEXT,project_id TEXT,stage TEXT,route_ref TEXT,route_version TEXT,
      candidate_ref TEXT,candidate_sha256 TEXT,qualification_ref TEXT,qualification_sha256 TEXT,qualification_json TEXT,
      observation_ref TEXT,observation_sha256 TEXT,qualification_tier TEXT,expires_at TEXT);
    CREATE TABLE provider_native_model_qualification_revocation(owner_ref TEXT,project_id TEXT,qualification_ref TEXT,qualification_sha256 TEXT);
    CREATE TABLE provider_native_model_catalog_v2_evidence(owner_ref TEXT,project_id TEXT,stage TEXT,state TEXT,
      candidate_ref TEXT,candidate_sha256 TEXT,qualification_ref TEXT,qualification_sha256 TEXT,candidate_json TEXT,
      qualification_json TEXT,preparation_json TEXT,provider_slug TEXT,model_id TEXT,alias TEXT);
    CREATE TABLE provider_native_model_catalog_v2_revocation(owner_ref TEXT,project_id TEXT,qualification_ref TEXT,qualification_sha256 TEXT);
  `);
  const table = admissionDdl.match(/CREATE TABLE research_model_spend_admission \([\s\S]*?\n\) STRICT;/)?.[0];
  if (table === undefined) throw new Error("Missing production admission table");
  db.exec(table);
  for (const name of ["shape_guard", "w2_guard", "immutable", "no_delete"]) {
    db.exec(trigger(admissionDdl, `research_model_spend_admission_${name}`));
  }
  db.exec(bindingDdl);
  db.exec(trigger(previous, "research_model_spend_admission_deployment_guard"));
  const stage = stageIndex === 12 ? "SYNTHESIZE" : "AUDIT_CLAIMS";
  const request = { protocol: "eliotr.workflow-stage.v1", operation_id: "run-1", stage,
    investigation_ref: { id: "investigation-1", revision: 1 }, idempotency_key: "run-idempotency", handler_generation: "research-handlers.exploratory.v4" };
  const requestJson = JSON.stringify(request);
  const requestSha = createHash("sha256").update(requestJson).digest("hex");
  const selections = ["SYNTHESIZE", "AUDIT_CLAIMS"].map(selectedStage => ({ stage: selectedStage,
    route_ref: deployment.route_ref, route_version: deployment.route_version,
    candidate_ref: `candidate-${selectedStage}`, candidate_sha256: sha,
    qualification_ref: `qualification-${selectedStage}`, qualification_sha256: otherSha,
    ...(family === "dynamic-route" ? {} : { candidate_kind: family, transport_policy: selectedTransport }) }));
  for (const pin of selections) {
    const preparation = { owner_ref: "owner-1", project_id: "project-1", stage: pin.stage, deployment,
      provider_slug: selectedTransport.provider, model_id: selectedTransport.model, transport_policy: selectedTransport };
    const candidate = { candidate_kind: family, qualification_tier: "LIVE", preparation, deployment, qualification_expires_at: future };
    const qualification = { candidate_kind: family, qualification_tier: "LIVE", candidate_ref: pin.candidate_ref,
      candidate_sha256: pin.candidate_sha256, owner_ref: "owner-1", project_id: "project-1", stage: pin.stage,
      expires_at: future, qualification: { tier: "LIVE", expires_at: future } };
    if (family === "provider-native-v2") {
      insert(db, "provider_native_model_catalog_v2_evidence", { owner_ref: "owner-1", project_id: "project-1", stage: pin.stage,
        state: "COMPLETED", candidate_ref: pin.candidate_ref, candidate_sha256: sha,
        qualification_ref: pin.qualification_ref, qualification_sha256: otherSha, candidate_json: JSON.stringify(candidate),
        qualification_json: JSON.stringify(qualification), preparation_json: JSON.stringify(preparation),
        provider_slug: transport.provider, model_id: transport.model, alias: transport.billing.alias });
    } else if (family === "provider-native-v1") {
      const identity = { owner_ref: "owner-1", project_id: "project-1", stage: pin.stage, route_ref: deployment.route_ref,
        route_version: deployment.route_version, candidate_ref: pin.candidate_ref, candidate_sha256: sha,
        observation_ref: `observation-${pin.stage}`, observation_sha256: sha, qualification_tier: "LIVE" };
      insert(db, "provider_native_model_candidate", { ...identity, candidate_json: JSON.stringify(candidate) });
      insert(db, "provider_native_model_qualification_proof", { ...identity, qualification_ref: pin.qualification_ref,
        qualification_sha256: otherSha, qualification_json: JSON.stringify(qualification), expires_at: future });
    } else {
      const identity = { route_ref: deployment.route_ref, route_version: deployment.route_version,
        candidate_ref: pin.candidate_ref, candidate_sha256: sha };
      insert(db, "dynamic_route_candidate", { ...identity, candidate_json: JSON.stringify(candidate) });
      insert(db, "dynamic_route_qualification_proof", { ...identity, qualification_ref: pin.qualification_ref,
        proof_sha256: otherSha, qualification_json: JSON.stringify(qualification) });
      if (pin.stage === stage) {
        insert(db, "dynamic_route_active_generation", identity);
        insert(db, "dynamic_route_active_qualification", { ...identity, qualification_ref: pin.qualification_ref, qualification_sha256: otherSha });
      }
    }
  }
  insert(db, "scope_snapshot", { snapshot_id: "scope-1", revision: 1 });
  insert(db, "research_workflow_run", { operation_id: "run-1", investigation_id: "investigation-1", principal_ref: "caller-1",
    credential_generation: "credential-1", deployment_generation: "deployment-1", configuration_required: 1, configuration_ref: "snapshot-1",
    state: "ACTIVE", next_stage_index: stageIndex, current_revision: 1, ledger_revision: 1, idempotency_key: "run-idempotency",
    handler_generation: request.handler_generation, policy_generation: "policy-1", policy_authority_ref: "policy-authority-1",
    scope_snapshot_id: "scope-1", scope_snapshot_revision: 1, authorization_receipt_ref: "grant-1" });
  insert(db, "research_workflow_attempt", { operation_id: "run-1", stage_index: stageIndex, attempt_ref: "attempt-1", state: "STARTED",
    expected_revision: 1, request_sha256: requestSha, request_json: requestJson, budget_receipt_ref: "budget-1", output_json: null });
  insert(db, "scope_access_grant", { snapshot_id: "scope-1", snapshot_revision: 1, principal_ref: "caller-1", client_class: "trusted_agent",
    credential_generation: "credential-1", policy_authority_ref: "policy-authority-1", authorization_receipt_ref: "grant-1",
    state: "ACTIVE", expires_at: future, allowed_use_json: '["research"]' });
  insert(db, "research_run_configuration", { operation_id: "run-1", configuration_ref: "snapshot-1", investigation_id: "investigation-1",
    principal_ref: "caller-1", deployment_generation: "deployment-1", mode: "snapshot-v2",
    configuration_json: JSON.stringify({ project_configuration: { owner_ref: "owner-1", project_id: "project-1" }, model_selections: selections }) });
  const intent = { intent_ref: { id: "model-1", revision: 1 }, principal_ref: "caller-1", operation_kind: "REPORT",
    policy_decision_ref: "decision-1", budget_reservation_ref: "reservation-1" };
  const authority = { principal_ref: "caller-1", client_class: "trusted_agent", credential_generation: "credential-1",
    deployment_generation: "deployment-1", policy_generation: "policy-1", policy_decision_ref: "decision-1",
    currentness_digest: sha, scope_snapshot_ref: { id: "scope-1", revision: 1 }, expires_at: future };
  const approval = { protocol: "eliotr.research-model-spend-approval.v1", approved: true, authorization_ref: "admission-1",
    decision_digest: sha, policy_decision_ref: "decision-1", policy_generation: "policy-1", currentness_digest: sha,
    expires_at: future, expected_deployment: deployment };
  const { scope_snapshot_ref: _scope, ...authorityColumns } = authority;
  void _scope;
  const row: Record<string, SQLInputValue> = { authorization_ref: "admission-1", operation_id: "model-1", workflow_operation_id: "run-1",
    stage_index: stageIndex, stage_attempt_ref: "attempt-1", stage_request_sha256: requestSha, stage_request_json: requestJson,
    workflow_budget_receipt_ref: "budget-1", intent_id: "model-1", intent_revision: 1, intent_json: JSON.stringify(intent),
    reservation_id: "reservation-1", quote_ref: "quote-1", quote_json: JSON.stringify({ quote_ref: "quote-1", reservation_id: "reservation-1", operation_kind: "REPORT", expires_at: future }),
    authority_json: JSON.stringify(authority), ...authorityColumns, scope_snapshot_id: "scope-1", scope_snapshot_revision: 1,
    workflow_authorization_receipt_ref: "grant-1", route_ref: deployment.route_ref, expected_deployment_json: JSON.stringify(deployment),
    approval_json: JSON.stringify(approval), admission_revision: 1, admission_sha256: sha, decision_digest: sha,
    max_input_bytes: 1024, max_output_bytes: 1024, expires_at: future, created_at: new Date().toISOString(), role: null };
  if (migrate) db.exec(replacement);
  return { db, row, admit: () => insert(db, "research_model_spend_admission", row), stage,
    cfg: (path: string, value: SQLInputValue) => db.prepare("UPDATE research_run_configuration SET configuration_json=json_set(configuration_json,?,?)").run(path, value) };
}

describe("0163 actual native spend-admission INSERT guards", () => {
  it("matches the exact live guard prerequisite, reproduces its rejection, then admits the same v2 row", () => {
    const f = fixture("provider-native-v2", 12, false);
    const sql = f.db.prepare("SELECT sql FROM sqlite_master WHERE name='research_model_spend_admission_deployment_guard'").get()?.sql;
    expect(createHash("sha256").update(String(sql)).digest("hex")).toBe(prerequisite);
    expect(f.admit).toThrow("MODEL_SPEND_ADMISSION_AUTHORITY_STALE");
    f.db.exec(replacement);
    expect(f.admit().changes).toBe(1);
  });
  it.each([12, 14])("admits exact native-v2 stage %s with owner/project distinct from the delegated caller", stage => {
    const f = fixture("provider-native-v2", stage);
    expect(f.admit().changes).toBe(1);
    expect(() => f.db.exec("UPDATE research_model_spend_admission SET max_input_bytes=2")).toThrow("MODEL_SPEND_ADMISSION_IMMUTABLE");
    expect(() => f.db.exec("DELETE FROM research_model_spend_admission")).toThrow("MODEL_SPEND_ADMISSION_IMMUTABLE");
  });
  it.each(["dynamic-route", "provider-native-v1"] as const)("retains exact %s snapshot authority", family => {
    expect(fixture(family).admit().changes).toBe(1);
  });
  it.each(["provider-native-v1", "provider-native-v2"] as const)("allows expired retained %s qualification only in snapshot-v2", family => {
    const f = fixture(family);
    if (family === "provider-native-v1") f.db.prepare("UPDATE provider_native_model_qualification_proof SET expires_at=?").run(past);
    else f.db.prepare("UPDATE provider_native_model_catalog_v2_evidence SET qualification_json=json_set(qualification_json,'$.expires_at',?)").run(past);
    expect(f.admit().changes).toBe(1);
    const v1 = fixture(family); v1.db.exec("UPDATE research_run_configuration SET mode='snapshot-v1'");
    expect(v1.admit).toThrow("MODEL_SPEND_ADMISSION_AUTHORITY_STALE");
  });
  const mutations: [string, (f: ReturnType<typeof fixture>) => unknown][] = [
    ["candidate pin", f => f.cfg("$.model_selections[0].candidate_ref", "wrong")],
    ["candidate digest", f => f.cfg("$.model_selections[0].candidate_sha256", otherSha)],
    ["qualification pin", f => f.cfg("$.model_selections[0].qualification_ref", "wrong")],
    ["qualification digest", f => f.cfg("$.model_selections[0].qualification_sha256", sha)],
    ["captured owner", f => f.cfg("$.project_configuration.owner_ref", "other-owner")],
    ["captured project", f => f.cfg("$.project_configuration.project_id", "other-project")],
    ["different stage", f => f.db.exec("UPDATE provider_native_model_catalog_v2_evidence SET stage='AUDIT_CLAIMS' WHERE stage='SYNTHESIZE'")],
    ["proof owner", f => f.db.exec("UPDATE provider_native_model_catalog_v2_evidence SET qualification_json=json_set(qualification_json,'$.owner_ref','other')")],
    ["non-completed evidence", f => f.db.exec("UPDATE provider_native_model_catalog_v2_evidence SET state='OBSERVED'")],
    ["non-LIVE qualification", f => f.db.exec("UPDATE provider_native_model_catalog_v2_evidence SET qualification_json=json_set(qualification_json,'$.qualification_tier','FIXTURE')")],
    ["transport model", f => f.cfg("$.model_selections[0].transport_policy.model", "other-model")],
    ["transport alias", f => f.cfg("$.model_selections[0].transport_policy.billing.alias", "other-alias")],
    ["unknown candidate family", f => f.cfg("$.model_selections[0].candidate_kind", "unknown")],
    ["NULL candidate family", f => f.cfg("$.model_selections[0].candidate_kind", null)],
    ["snapshot investigation", f => f.db.exec("UPDATE research_run_configuration SET investigation_id='other'")],
    ["snapshot actor", f => f.db.exec("UPDATE research_run_configuration SET principal_ref='other'")],
    ["snapshot deployment", f => f.db.exec("UPDATE research_run_configuration SET deployment_generation='other'")],
    ["snapshot mode", f => f.db.exec("UPDATE research_run_configuration SET mode='legacy-installed'")],
    ["missing snapshot", f => f.db.exec("DELETE FROM research_run_configuration")],
    ["snapshot pointer", f => f.db.exec("UPDATE research_workflow_run SET configuration_ref='other'")],
    ["stage attempt", f => f.db.exec("UPDATE research_workflow_attempt SET state='COMPLETED'")],
    ["stage digest", f => f.db.exec("UPDATE research_workflow_attempt SET request_sha256='wrong'")],
    ["workflow deployment", f => f.db.exec("UPDATE research_workflow_run SET deployment_generation='rotated'")],
    ["workflow budget", f => f.db.exec("UPDATE research_workflow_attempt SET budget_receipt_ref='wrong'")],
    ["revoked grant", f => f.db.exec("UPDATE scope_access_grant SET state='REVOKED'")],
    ["expired grant", f => f.db.prepare("UPDATE scope_access_grant SET expires_at=?").run(past)],
    ["grant generation", f => f.db.exec("UPDATE scope_access_grant SET credential_generation='rotated'")],
    ["grant policy", f => f.db.exec("UPDATE scope_access_grant SET policy_authority_ref='other'")],
    ["grant use", f => f.db.exec("UPDATE scope_access_grant SET allowed_use_json='[]'")],
    ["duplicate selected stage", f => f.db.exec("UPDATE research_run_configuration SET configuration_json=json_insert(configuration_json,'$.model_selections[#]',json_extract(configuration_json,'$.model_selections[0]'))")],
  ];
  it.each(mutations)("rejects %s through the actual INSERT", (_name, mutate) => {
    const f = fixture(); mutate(f);
    expect(f.admit).toThrow("MODEL_SPEND_ADMISSION_AUTHORITY_STALE");
    expect(f.db.prepare("SELECT count(*) AS n FROM research_model_spend_admission").get()?.n).toBe(0);
  });
  it.each(Object.keys(deployment))("rejects changed deployment field %s", key => {
    const f = fixture();
    const changed = { ...deployment, [key]: "wrong" };
    f.row.expected_deployment_json = JSON.stringify(changed);
    f.row.approval_json = JSON.stringify({ ...JSON.parse(String(f.row.approval_json)), expected_deployment: changed });
    if (key === "route_ref") f.row.route_ref = "wrong";
    expect(f.admit).toThrow("MODEL_SPEND_ADMISSION_AUTHORITY_STALE");
  });
  it.each(["dynamic-route", "provider-native-v1", "provider-native-v2"] as const)("rejects exact revoked %s proof", family => {
    const f = fixture(family);
    const table = family === "dynamic-route" ? "dynamic_route_qualification_revocation"
      : family === "provider-native-v1" ? "provider_native_model_qualification_revocation" : "provider_native_model_catalog_v2_revocation";
    insert(f.db, table, { qualification_ref: "qualification-SYNTHESIZE", qualification_sha256: otherSha,
      ...(family === "dynamic-route" ? {} : { owner_ref: "owner-1", project_id: "project-1" }) });
    expect(f.admit).toThrow("MODEL_SPEND_ADMISSION_AUTHORITY_STALE");
  });
  it("preserves dynamic snapshot-v1 expiry and legacy active/latest-proof behavior", () => {
    const f = fixture("dynamic-route");
    f.db.exec("UPDATE research_run_configuration SET mode='snapshot-v1'");
    f.db.prepare("UPDATE dynamic_route_qualification_proof SET qualification_json=json_set(qualification_json,'$.qualification.expires_at',?)").run(past);
    expect(f.admit).toThrow("MODEL_SPEND_ADMISSION_AUTHORITY_STALE");
    f.db.exec("UPDATE research_run_configuration SET mode='snapshot-v2'");
    expect(f.admit().changes).toBe(1);
    const legacy = fixture("dynamic-route");
    legacy.db.exec("UPDATE research_workflow_run SET configuration_required=0,configuration_ref=NULL; DELETE FROM research_run_configuration");
    expect(legacy.admit().changes).toBe(1);
    const expired = fixture("dynamic-route");
    expired.db.exec("UPDATE research_workflow_run SET configuration_required=0,configuration_ref=NULL; DELETE FROM research_run_configuration");
    expired.db.prepare("UPDATE dynamic_route_qualification_proof SET qualification_json=json_set(qualification_json,'$.qualification.expires_at',?)").run(past);
    expect(expired.admit).toThrow("MODEL_SPEND_ADMISSION_AUTHORITY_STALE");
  });
  it("installs after the full immutable migration chain without changing admission constraints or unrelated guards", () => {
    const db = new DatabaseSync(":memory:"); opened.push(db);
    for (const name of readdirSync(migrations).filter(name => /^\d+.*\.sql$/.test(name) && name < "0163_").sort()) db.exec(source(name));
    const before = db.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='research_model_spend_admission' AND name<>'research_model_spend_admission_deployment_guard' ORDER BY name").all();
    db.exec(replacement);
    expect(db.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='research_model_spend_admission' AND name<>'research_model_spend_admission_deployment_guard' ORDER BY name").all()).toEqual(before);
    expect(db.prepare("EXPLAIN INSERT INTO research_model_spend_admission(authorization_ref) VALUES ('compile-only')").all().length).toBeGreaterThan(0);
  });
});
