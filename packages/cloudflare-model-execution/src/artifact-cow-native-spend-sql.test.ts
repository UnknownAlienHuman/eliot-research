/// <reference types="node" />
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../../../infra/d1/core/migrations/", import.meta.url));
const read = (name: string) => readFileSync(`${directory}/${name}`, "utf8");
const cowDdl = read("0100_artifact_section_revise_authority.sql");
const pinnedDdl = read("0105_research_pinned_model_authority.sql");
const proofDdl = read("0163_research_native_model_spend_authority.sql");
const migration = read("0164_artifact_cow_native_model_spend_authority.sql");
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const sha = "a".repeat(64), proofSha = "b".repeat(64);
const future = "2099-01-01T00:00:00.000Z", past = "2000-01-01T00:00:00.000Z";
const deployment = { route_ref: "dynamic/eliotr-balanced", route_version: "v1", prompt_generation: "prompt-1",
  schema_generation: "schema-1", parameters_digest: sha, pricing_snapshot_ref: "pricing-1" };
type Family = "dynamic-route" | "provider-native-v1" | "provider-native-v2";
type Slot = "SYNTHESIZE" | "INDEPENDENT_VERIFY";
function trigger(source: string, name: string) {
  const sql = source.match(new RegExp(`CREATE TRIGGER ${name}\\b[\\s\\S]*?\\bEND;`))?.[0];
  if (sql === undefined) throw new Error(`Missing production trigger ${name}`);
  return sql;
}
function insert(db: DatabaseSync, table: string, row: Record<string, SQLInputValue>) {
  return db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
    .run(...Object.values(row));
}

// Controlled ancestor readback; the COW admission table, constraints and all its
// guards come from immutable migrations. The real shared 0163 view is installed.
// This tests the storage INSERT boundary, not Core's witness or provider producer.
function fixture(family: Family = "provider-native-v2", slot: Slot = "SYNTHESIZE", apply = true) {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE scope_snapshot(snapshot_id TEXT,revision INTEGER,PRIMARY KEY(snapshot_id,revision));
    CREATE TABLE artifact_section_revise_run(operation_id TEXT PRIMARY KEY,request_json TEXT,state TEXT,principal_ref TEXT,
      credential_generation TEXT,deployment_generation TEXT,policy_generation TEXT,scope_snapshot_id TEXT,
      scope_snapshot_revision INTEGER,authorization_receipt_ref TEXT);
    CREATE VIEW artifact_section_revise_current AS SELECT * FROM artifact_section_revise_run WHERE state='ACTIVE';
    CREATE TABLE artifact_section_revise_attempt(operation_id TEXT,attempt_ref TEXT,request_json TEXT,request_sha256 TEXT,
      state TEXT,output_json TEXT,budget_receipt_ref TEXT,budget_max_total_usd REAL,PRIMARY KEY(operation_id,attempt_ref));
    CREATE TABLE research_workflow_run(operation_id TEXT,investigation_id TEXT,principal_ref TEXT,deployment_generation TEXT,configuration_ref TEXT);
    CREATE TABLE research_run_configuration(operation_id TEXT,investigation_id TEXT,principal_ref TEXT,deployment_generation TEXT,
      configuration_ref TEXT,configuration_sha256 TEXT,mode TEXT,configuration_json TEXT);
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
  const table = cowDdl.match(/CREATE TABLE artifact_section_revise_spend_admission \([\s\S]*?\n\) STRICT;/)?.[0];
  const view = proofDdl.match(/CREATE VIEW research_model_spend_pinned_authority[\s\S]*?;\n/)?.[0];
  if (table === undefined || view === undefined) throw new Error("Missing immutable production SQL");
  db.exec(table); db.exec(view);
  for (const name of ["shape_guard", "budget_guard", "immutable", "no_delete"]) {
    db.exec(trigger(cowDdl, `artifact_section_revise_spend_${name}`));
  }
  for (const name of ["pin_shape_guard", "pin_witness_guard", "deployment_guard", "snapshot_association_guard", "snapshot_tuple_guard", "snapshot_currentness_guard"]) {
    db.exec(trigger(pinnedDdl, `artifact_section_revise_spend_${name}`));
  }
  const transport = { version: 1, transport: "cloudflare-ai-gateway",
    api: family === "provider-native-v1" ? "openrouter-chat-completions" : "custom-chat-completions",
    provider: family === "provider-native-v1" ? "openrouter" : "custom-opencode-go", model: "muse-spark-1.3-contributor",
    billing: { mode: "byok", alias: `eliotr-${"c".repeat(48)}`, ...(family === "provider-native-v1" ? { free_only: true } : {}) },
    capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["high"] } };
  const selections = ["SYNTHESIZE", "AUDIT_CLAIMS"].map(stage => ({ stage, route_ref: deployment.route_ref,
    route_version: deployment.route_version, candidate_ref: `candidate-${stage}`, candidate_sha256: sha,
    qualification_ref: `qualification-${stage}`, qualification_sha256: proofSha,
    ...(family === "dynamic-route" ? {} : { candidate_kind: family, transport_policy: transport }) }));
  for (const pin of selections) {
    const preparation = { owner_ref: "owner-1", project_id: "project-1", stage: pin.stage, deployment,
      provider_slug: transport.provider, model_id: transport.model, transport_policy: transport };
    const candidate = { candidate_kind: family, qualification_tier: "LIVE", preparation, deployment, qualification_expires_at: future };
    const qualification = { candidate_kind: family, qualification_tier: "LIVE", candidate_ref: pin.candidate_ref, candidate_sha256: sha,
      owner_ref: "owner-1", project_id: "project-1", stage: pin.stage, expires_at: future, qualification: { tier: "LIVE", expires_at: future } };
    if (family === "provider-native-v2") {
      insert(db, "provider_native_model_catalog_v2_evidence", { owner_ref: "owner-1", project_id: "project-1", stage: pin.stage,
        state: "COMPLETED", candidate_ref: pin.candidate_ref, candidate_sha256: sha, qualification_ref: pin.qualification_ref,
        qualification_sha256: proofSha, candidate_json: JSON.stringify(candidate), qualification_json: JSON.stringify(qualification),
        preparation_json: JSON.stringify(preparation), provider_slug: transport.provider, model_id: transport.model, alias: transport.billing.alias });
    } else if (family === "provider-native-v1") {
      const identity = { owner_ref: "owner-1", project_id: "project-1", stage: pin.stage, route_ref: deployment.route_ref,
        route_version: deployment.route_version, candidate_ref: pin.candidate_ref, candidate_sha256: sha,
        observation_ref: `observation-${pin.stage}`, observation_sha256: sha, qualification_tier: "LIVE" };
      insert(db, "provider_native_model_candidate", { ...identity, candidate_json: JSON.stringify(candidate) });
      insert(db, "provider_native_model_qualification_proof", { ...identity, qualification_ref: pin.qualification_ref,
        qualification_sha256: proofSha, qualification_json: JSON.stringify(qualification), expires_at: future });
    } else {
      const identity = { route_ref: deployment.route_ref, route_version: deployment.route_version,
        candidate_ref: pin.candidate_ref, candidate_sha256: sha };
      insert(db, "dynamic_route_candidate", { ...identity, candidate_json: JSON.stringify(candidate) });
      insert(db, "dynamic_route_qualification_proof", { ...identity, qualification_ref: pin.qualification_ref,
        proof_sha256: proofSha, qualification_json: JSON.stringify(qualification) });
      if (pin.stage === (slot === "SYNTHESIZE" ? "SYNTHESIZE" : "AUDIT_CLAIMS")) {
        insert(db, "dynamic_route_active_generation", identity);
        insert(db, "dynamic_route_active_qualification", { ...identity, qualification_ref: pin.qualification_ref, qualification_sha256: proofSha });
      }
    }
  }
  const association = { operation_id: "research-1", investigation_id: "investigation-1", principal_ref: "owner-1", deployment_generation: "research-deployment" };
  insert(db, "research_workflow_run", { ...association, configuration_ref: "configuration-1" });
  insert(db, "research_run_configuration", { ...association, configuration_ref: "configuration-1", configuration_sha256: sha, mode: "snapshot-v2",
    configuration_json: JSON.stringify({ project_configuration: { configuration_ref: "project-config-1", owner_ref: "owner-1", project_id: "project-1" }, model_selections: selections }) });
  insert(db, "scope_snapshot", { snapshot_id: "scope-1", revision: 1 });
  insert(db, "artifact_section_revise_run", { operation_id: "cow-1", request_json: "{}", state: "ACTIVE", principal_ref: "owner-1",
    credential_generation: "cow-session", deployment_generation: "cow-deployment", policy_generation: "policy-1",
    scope_snapshot_id: "scope-1", scope_snapshot_revision: 1, authorization_receipt_ref: "grant-1" });
  insert(db, "artifact_section_revise_attempt", { operation_id: "cow-1", attempt_ref: "attempt-1", request_json: "{}", request_sha256: sha,
    state: "STARTED", output_json: null, budget_receipt_ref: "budget-1", budget_max_total_usd: 0.75 });
  const authority = { principal_ref: "owner-1", client_class: "owner_pwa", credential_generation: "cow-session",
    deployment_generation: "cow-deployment", policy_decision_ref: "decision-1", policy_generation: "policy-1", currentness_digest: sha,
    scope_snapshot_ref: { id: "scope-1", revision: 1 }, expires_at: future };
  const intent = { intent_ref: { id: "model-1", revision: 1 }, principal_ref: "owner-1", operation_kind: "REPORT", budget_reservation_ref: "reservation-1" };
  const approval = { protocol: "eliotr.research-model-spend-approval.v1", approved: true, authorization_ref: "authorization-1",
    decision_digest: sha, policy_decision_ref: "decision-1", policy_generation: "policy-1", currentness_digest: sha, expires_at: future,
    expected_deployment: deployment };
  const { scope_snapshot_ref: _scope, ...authorityColumns } = authority; void _scope;
  const row: Record<string, SQLInputValue> = { authorization_ref: "authorization-1", operation_id: "model-1", call_slot: slot,
    workflow_operation_id: "cow-1", stage_attempt_ref: "attempt-1", stage_request_sha256: sha, workflow_budget_receipt_ref: "budget-1",
    stage_request_json: "{}", intent_id: "model-1", intent_revision: 1, intent_json: JSON.stringify(intent), reservation_id: "reservation-1",
    quote_ref: "quote-1", quote_json: JSON.stringify({ reservation_id: "reservation-1", quote_ref: "quote-1", operation_kind: "REPORT", expires_at: future, max_total_usd: 0.5 }),
    authority_json: JSON.stringify(authority), ...authorityColumns, scope_snapshot_id: "scope-1", scope_snapshot_revision: 1,
    workflow_authorization_receipt_ref: "grant-1", route_ref: deployment.route_ref, expected_deployment_json: JSON.stringify(deployment),
    approval_json: JSON.stringify(approval), admission_revision: 1, admission_sha256: sha, decision_digest: sha, request_json: "{}",
    max_input_bytes: 1024, max_output_bytes: 1024, expires_at: future, created_at: new Date().toISOString() };
  function syncWitness(legacy = false) {
    const cfg = db.prepare("SELECT * FROM research_run_configuration").get();
    if (cfg === undefined) throw new Error("Missing fixture configuration");
    const { configuration_json, ...identity } = cfg;
    const pin = legacy ? null : { ...identity, model_selections: JSON.parse(String(configuration_json)).model_selections };
    const request = { protocol: "eliotr.artifact.section.revise.v1", operation_id: "cow-1",
      report_admission_witness: { material: { run_configuration: pin } } };
    const stageRequest = JSON.stringify({ request, attempt_ref: "attempt-1" });
    row.request_json = JSON.stringify({ run_configuration: pin }); row.stage_request_json = stageRequest;
    row.stage_request_sha256 = createHash("sha256").update(stageRequest).digest("hex");
    db.prepare("UPDATE artifact_section_revise_run SET request_json=?").run(JSON.stringify(request));
    db.prepare("UPDATE artifact_section_revise_attempt SET request_json=?,request_sha256=?").run(stageRequest, row.stage_request_sha256);
  }
  syncWitness();
  if (apply) db.exec(migration);
  return { db, row, syncWitness, admit: () => insert(db, "artifact_section_revise_spend_admission", row),
    patch: (path: string, value: SQLInputValue) => {
      db.prepare("UPDATE research_run_configuration SET configuration_json=json_set(configuration_json,?,?)").run(path, value); syncWitness();
    } };
}

describe("0164 actual COW native proof INSERT gates", () => {
  it.each(["provider-native-v1", "provider-native-v2"] as const)("reproduces the pre-0164 %s rejection and admits the identical row after migration", family => {
    const f = fixture(family, "SYNTHESIZE", false);
    expect(f.admit).toThrow("ARTIFACT_COW_AUTHORITY_STALE"); f.db.exec(migration); expect(f.admit().changes).toBe(1);
  });
  it.each(["provider-native-v1", "provider-native-v2", "dynamic-route"] as const)("admits both COW slots for exact %s pins", family => {
    for (const slot of ["SYNTHESIZE", "INDEPENDENT_VERIFY"] as const) expect(fixture(family, slot).admit().changes).toBe(1);
  });
  const mutations: [string, (f: ReturnType<typeof fixture>) => unknown][] = [
    ["candidate pin", f => f.patch("$.model_selections[0].candidate_ref", "wrong")],
    ["candidate digest", f => f.patch("$.model_selections[0].candidate_sha256", proofSha)],
    ["qualification pin", f => f.patch("$.model_selections[0].qualification_ref", "wrong")],
    ["qualification digest", f => f.patch("$.model_selections[0].qualification_sha256", sha)],
    ["captured owner", f => f.patch("$.project_configuration.owner_ref", "wrong")],
    ["captured project", f => f.patch("$.project_configuration.project_id", "wrong")],
    ["missing owner binding", f => f.patch("$.project_configuration.owner_ref", null)],
    ["transport alias", f => f.patch("$.model_selections[0].transport_policy.billing.alias", "wrong")],
    ["transport model", f => f.patch("$.model_selections[0].transport_policy.model", "wrong")],
    ["unknown family", f => f.patch("$.model_selections[0].candidate_kind", "unknown")],
    ["NULL family", f => f.patch("$.model_selections[0].candidate_kind", null)],
    ["snapshot-v1 Native", f => { f.db.exec("UPDATE research_run_configuration SET mode='snapshot-v1'"); f.syncWitness(); }],
    ["original actor", f => { f.db.exec("UPDATE research_run_configuration SET principal_ref='wrong'"); f.syncWitness(); }],
    ["original deployment", f => { f.db.exec("UPDATE research_run_configuration SET deployment_generation='wrong'"); f.syncWitness(); }],
    ["original investigation", f => { f.db.exec("UPDATE research_run_configuration SET investigation_id='wrong'"); f.syncWitness(); }],
    ["original snapshot pointer", f => f.db.exec("UPDATE research_workflow_run SET configuration_ref='wrong'")],
    ["witness drift", f => { f.row.request_json = JSON.stringify({ run_configuration: null }); }],
    ["snapshot array shape", f => { f.row.request_json = '{"run_configuration":[]}'; }],
    ["current scope", f => f.db.exec("UPDATE artifact_section_revise_run SET scope_snapshot_id='wrong'")],
    ["current owner", f => f.db.exec("UPDATE artifact_section_revise_run SET principal_ref='wrong'")],
    ["current session", f => f.db.exec("UPDATE artifact_section_revise_run SET credential_generation='wrong'")],
    ["current deployment", f => f.db.exec("UPDATE artifact_section_revise_run SET deployment_generation='wrong'")],
    ["current grant", f => f.db.exec("UPDATE artifact_section_revise_run SET authorization_receipt_ref='wrong'")],
    ["stopped COW", f => f.db.exec("UPDATE artifact_section_revise_run SET state='CANCELLED'")],
    ["completed attempt", f => f.db.exec("UPDATE artifact_section_revise_attempt SET state='COMPLETED'")],
    ["workflow budget identity", f => f.db.exec("UPDATE artifact_section_revise_attempt SET budget_receipt_ref='wrong'")],
  ];
  it.each(mutations)("denies %s on the real INSERT", (_name, mutate) => {
    const f = fixture(); mutate(f); expect(f.admit).toThrow(/ARTIFACT_COW_/);
    expect(f.db.prepare("SELECT count(*) AS n FROM artifact_section_revise_spend_admission").get()?.n).toBe(0);
  });
  it.each(["provider-native-v1", "provider-native-v2"] as const)("denies a valid proof from the other stage for %s", family => {
    const f = fixture(family);
    f.patch("$.model_selections[0].candidate_ref", "candidate-AUDIT_CLAIMS");
    f.patch("$.model_selections[0].qualification_ref", "qualification-AUDIT_CLAIMS");
    expect(f.admit).toThrow("ARTIFACT_COW_AUTHORITY_STALE");
  });
  it("does not accept the internal dynamic family label as a wire candidate kind", () => {
    const f = fixture("dynamic-route"); f.patch("$.model_selections[0].candidate_kind", "dynamic-route");
    expect(f.admit).toThrow("ARTIFACT_COW_AUTHORITY_STALE");
  });
  it.each(["provider-native-v1", "provider-native-v2", "dynamic-route"] as const)("retains %s revocation and qualification expiry semantics", family => {
    const f = fixture(family);
    const table = family === "dynamic-route" ? "dynamic_route_qualification_revocation"
      : family === "provider-native-v1" ? "provider_native_model_qualification_revocation" : "provider_native_model_catalog_v2_revocation";
    insert(f.db, table, { qualification_ref: "qualification-SYNTHESIZE", qualification_sha256: proofSha,
      ...(family === "dynamic-route" ? {} : { owner_ref: "owner-1", project_id: "project-1" }) });
    expect(f.admit).toThrow("ARTIFACT_COW_AUTHORITY_STALE");
    const retained = fixture(family);
    if (family === "provider-native-v1") retained.db.prepare("UPDATE provider_native_model_qualification_proof SET expires_at=?").run(past);
    else if (family === "provider-native-v2") retained.db.prepare("UPDATE provider_native_model_catalog_v2_evidence SET qualification_json=json_set(qualification_json,'$.expires_at',?)").run(past);
    else retained.db.prepare("UPDATE dynamic_route_qualification_proof SET qualification_json=json_set(qualification_json,'$.qualification.expires_at',?)").run(past);
    expect(retained.admit().changes).toBe(1);
  });
  it.each(Object.keys(deployment))("denies changed deployment field %s", key => {
    const f = fixture(); const changed = { ...deployment, [key]: "wrong" };
    f.row.expected_deployment_json = JSON.stringify(changed);
    f.row.approval_json = JSON.stringify({ ...JSON.parse(String(f.row.approval_json)), expected_deployment: changed });
    if (key === "route_ref") f.row.route_ref = "wrong";
    expect(f.admit).toThrow("ARTIFACT_COW_AUTHORITY_STALE");
  });
  it("retains shared budget, immutability and legacy active/latest-proof gates", () => {
    const f = fixture(); expect(f.admit().changes).toBe(1);
    f.row.operation_id = "model-2"; f.row.authorization_ref = "authorization-2"; f.row.call_slot = "INDEPENDENT_VERIFY";
    f.row.approval_json = JSON.stringify({ ...JSON.parse(String(f.row.approval_json)), authorization_ref: "authorization-2" });
    expect(f.admit).toThrow("ARTIFACT_COW_SPEND_LIMIT");
    expect(() => f.db.exec("UPDATE artifact_section_revise_spend_admission SET max_input_bytes=2")).toThrow("ARTIFACT_COW_IMMUTABLE");
    expect(() => f.db.exec("DELETE FROM artifact_section_revise_spend_admission")).toThrow("ARTIFACT_COW_IMMUTABLE");
    const legacy = fixture("dynamic-route"); legacy.syncWitness(true); expect(legacy.admit().changes).toBe(1);
    const expired = fixture("dynamic-route"); expired.syncWitness(true);
    expired.db.prepare("UPDATE dynamic_route_qualification_proof SET qualification_json=json_set(qualification_json,'$.qualification.expires_at',?)").run(past);
    expect(expired.admit).toThrow("ARTIFACT_COW_AUTHORITY_STALE");
    const v1 = fixture("dynamic-route"); v1.db.exec("UPDATE research_run_configuration SET mode='snapshot-v1'"); v1.syncWitness();
    v1.db.prepare("UPDATE dynamic_route_qualification_proof SET qualification_json=json_set(qualification_json,'$.qualification.expires_at',?)").run(past);
    expect(v1.admit).toThrow("ARTIFACT_COW_AUTHORITY_STALE");
  });
  it("installs on the full schema and leaves all other COW guards, constraints and sealed 0163 proof objects unchanged", () => {
    const db = new DatabaseSync(":memory:"); databases.push(db);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name) && name < "0164_").sort()) db.exec(read(name));
    const preserved = "SELECT name,sql FROM sqlite_master WHERE (tbl_name='artifact_section_revise_spend_admission' OR name IN ('research_model_spend_pinned_authority','research_model_spend_admission_deployment_guard')) AND name NOT IN ('artifact_section_revise_spend_snapshot_tuple_guard','artifact_section_revise_spend_snapshot_currentness_guard') ORDER BY name";
    const before = db.prepare(preserved).all(); db.exec(migration); expect(db.prepare(preserved).all()).toEqual(before);
    expect(db.prepare("EXPLAIN INSERT INTO artifact_section_revise_spend_admission(authorization_ref) VALUES ('compile-only')").all().length).toBeGreaterThan(0);
  });
});
