import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const runtime = env as unknown as { readonly CORE_MIGRATIONS: readonly D1Migration[]; readonly SEARCH_DB: D1Database };
const database = runtime.SEARCH_DB;

function migration(name: string): D1Migration {
  const found = runtime.CORE_MIGRATIONS.find((item) => item.name.endsWith(name));
  if (found === undefined) throw new Error(`missing migration ${name}`);
  return found;
}

function triggerSql(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE TRIGGER ${name}`);
  if (start < 0) throw new Error(`missing trigger ${name}`);
  const body = sql.indexOf("BEGIN", start);
  const end = body < 0 ? -1 : sql.indexOf("END", body + "BEGIN".length);
  if (end < 0) throw new Error(`unterminated trigger ${name}`);
  return sql.slice(start, end + "END".length) + (sql[end + 3] === ";" ? ";" : "");
}

async function scratch(): Promise<void> {
  await reset();
  const ddl = [
    `CREATE TABLE scope_access_grant (
      snapshot_id TEXT NOT NULL, snapshot_revision INTEGER NOT NULL, principal_ref TEXT NOT NULL,
      project_client_grant_id TEXT, project_client_grant_revision INTEGER, project_client_operation TEXT,
      project_client_run_operation_id TEXT, state TEXT, expires_at TEXT
    )`,
    `CREATE TABLE scope_access_grant_effective (
      snapshot_id TEXT, snapshot_revision INTEGER, principal_ref TEXT, client_class TEXT,
      project_client_operation TEXT, project_client_run_operation_id TEXT, credential_generation TEXT,
      authorization_receipt_ref TEXT, expires_at TEXT
    )`,
    `CREATE TABLE research_workflow_current (
      operation_id TEXT, principal_ref TEXT, scope_snapshot_id TEXT, scope_snapshot_revision INTEGER,
      credential_generation TEXT, authorization_receipt_ref TEXT, state TEXT, next_stage_index INTEGER,
      current_revision INTEGER
    )`,
    `CREATE TABLE research_workflow_attempt (
      operation_id TEXT, stage_index INTEGER, state TEXT, output_json TEXT, expected_revision INTEGER,
      budget_expires_at_ms INTEGER, request_json TEXT
    )`,
    `CREATE TABLE research_report_admission (
      operation_id TEXT, intent_id TEXT, intent_revision INTEGER, principal_ref TEXT, idempotency_key TEXT,
      scope_snapshot_id TEXT, scope_snapshot_revision INTEGER, client_class TEXT, credential_generation TEXT,
      authorization_receipt_ref TEXT, expires_at TEXT
    )`,
    `CREATE TABLE artifact_draft_reservation (
      intent_id TEXT, intent_revision INTEGER, artifact_id TEXT, artifact_revision INTEGER, request_sha256 TEXT,
      spec_digest TEXT, manifest_r2_key TEXT, expected_head_revision INTEGER, spec_ref_id TEXT,
      spec_ref_revision INTEGER, scope_snapshot_id TEXT, scope_snapshot_revision INTEGER, intent_json TEXT,
      principal_ref TEXT, idempotency_key TEXT, payload_ref TEXT, topic TEXT, planned_objects_json TEXT,
      state TEXT, created_at TEXT, updated_at TEXT
    )`,
  ];
  for (const sql of ddl) await database.prepare(sql).run();
}

function dropTriggerSql(sql: string, name: string): string {
  const start = sql.indexOf(`DROP TRIGGER ${name}`);
  if (start < 0) throw new Error(`missing DROP TRIGGER ${name}`);
  return sql.slice(start, start + `DROP TRIGGER ${name}`.length) + ";";
}

const ids = {
  operation: "run-native-stage17",
  principal: "service-agent.access",
  scope: "scope-native-stage17",
  credential: "credential-native-stage17",
  authorization: "authorization-native-stage17",
  idempotency: "stage17-idempotency-native",
  intent: "report-intent-native-stage17",
  payload: "report-payload-native-stage17",
  artifact: "artifact-native-stage17",
  now: new Date().toISOString(),
  expires: new Date(Date.now() + 60_000).toISOString(),
};

function intentJson(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ intent_ref: { id: ids.intent, revision: 1 }, operation_kind: "REPORT",
    principal_ref: ids.principal, idempotency_key: ids.idempotency, payload_ref: ids.payload, ...patch });
}

function reservation(patch: Record<string, unknown> = {}) {
  const value = {
    intent_id: ids.intent, intent_revision: 1, artifact_id: ids.artifact, artifact_revision: 1,
    request_sha256: "a".repeat(64), spec_digest: "b".repeat(64), manifest_r2_key: "draft/manifest",
    expected_head_revision: null, spec_ref_id: "spec-native", spec_ref_revision: 1,
    scope_snapshot_id: ids.scope, scope_snapshot_revision: 1, intent_json: intentJson(),
    principal_ref: ids.principal, idempotency_key: ids.idempotency, payload_ref: ids.payload,
    topic: "research.artifact-draft", planned_objects_json: "[]", state: "RESERVED",
    created_at: ids.now, updated_at: ids.now, ...patch,
  };
  const names = Object.keys(value);
  const statement = database.prepare(`INSERT INTO artifact_draft_reservation (${names.join(",")}) VALUES (${names.map((_, i) => `?${i + 1}`).join(",")})`);
  return statement.bind(...Object.values(value));
}

async function seedAuthority(): Promise<void> {
  await database.prepare("INSERT INTO scope_access_grant VALUES (?1,1,?2,'grant-native',1,'run',?3,'ACTIVE',?4)")
    .bind(ids.scope, ids.principal, ids.operation, ids.expires).run();
  await database.prepare("INSERT INTO scope_access_grant_effective VALUES (?1,1,?2,'trusted_agent','run',?3,?4,?5,?6)")
    .bind(ids.scope, ids.principal, ids.operation, ids.credential, ids.authorization, ids.expires).run();
  await database.prepare("INSERT INTO research_workflow_current VALUES (?1,?2,?3,1,?4,?5,'ACTIVE',17,9)")
    .bind(ids.operation, ids.principal, ids.scope, ids.credential, ids.authorization).run();
  await database.prepare("INSERT INTO research_workflow_attempt VALUES (?1,17,'STARTED',NULL,9,?2,?3)")
    .bind(ids.operation, Date.now() + 60_000, JSON.stringify({ stage: "MATERIALIZE", operation_id: ids.operation,
      idempotency_key: ids.idempotency })).run();
}

describe("delegated REPORT draft reservation migration guards on native D1", () => {
  it("reproduces 0076's premature-admission abort, then permits only its exact live Stage17 identity", async () => {
    const old = migration("0076_project_client_execution.sql");
    await scratch();
    await database.prepare(triggerSql(old.queries.join("\n"), "client_execution_artifact_intent_guard")).run();
    await seedAuthority();
    await expect(reservation().run()).rejects.toThrow("REPORT_ADMISSION_AUTHORITY_STALE");
    expect(await database.prepare("SELECT COUNT(*) AS n FROM artifact_draft_reservation").first())
      .toMatchObject({ n: 0 });

    const current = migration("0155_delegated_report_reservation.sql");
    const currentSql = current.queries.join("\n");
    await database.prepare(dropTriggerSql(currentSql, "client_execution_artifact_intent_guard")).run();
    await database.prepare(triggerSql(currentSql, "client_execution_artifact_intent_guard")).run();
    await database.prepare(triggerSql(currentSql, "client_execution_artifact_finalize_guard")).run();

    await expect(reservation({ principal_ref: "foreign-service.access",
      intent_json: intentJson({ principal_ref: "foreign-service.access" }) }).run())
      .rejects.toThrow("REPORT_ADMISSION_AUTHORITY_STALE");
    await expect(reservation({ scope_snapshot_id: "foreign-scope" }).run())
      .rejects.toThrow("REPORT_ADMISSION_AUTHORITY_STALE");
    await expect(reservation({ idempotency_key: "wrong-stage-key" }).run())
      .rejects.toThrow("REPORT_ADMISSION_AUTHORITY_STALE");
    await expect(reservation({ state: "FINALIZED" }).run())
      .rejects.toThrow("REPORT_ADMISSION_AUTHORITY_STALE");

    await database.prepare("DELETE FROM scope_access_grant_effective WHERE snapshot_id=?1").bind(ids.scope).run();
    await expect(reservation({ artifact_id: "artifact-revoked" }).run())
      .rejects.toThrow("REPORT_ADMISSION_AUTHORITY_STALE");
    await seedAuthority();

    await reservation().run();
    expect(await database.prepare("SELECT state FROM artifact_draft_reservation WHERE intent_id=?1")
      .bind(ids.intent).first()).toEqual({ state: "RESERVED" });
    await expect(database.prepare("UPDATE artifact_draft_reservation SET state='FINALIZED' WHERE intent_id=?1")
      .bind(ids.intent).run()).rejects.toThrow("REPORT_ADMISSION_AUTHORITY_STALE");
    expect(await database.prepare("SELECT state FROM artifact_draft_reservation WHERE intent_id=?1")
      .bind(ids.intent).first()).toEqual({ state: "RESERVED" });

    await database.prepare("INSERT INTO research_report_admission VALUES (?1,?2,1,?3,?4,?5,1,'trusted_agent',?6,?7,?8)")
      .bind(ids.operation, ids.intent, ids.principal, ids.idempotency, ids.scope, ids.credential, ids.authorization, ids.expires).run();
    await expect(database.prepare("UPDATE artifact_draft_reservation SET state='FINALIZED' WHERE intent_id=?1")
      .bind(ids.intent).run()).resolves.toMatchObject({ success: true });
    expect(await database.prepare("SELECT state FROM artifact_draft_reservation WHERE intent_id=?1")
      .bind(ids.intent).first()).toEqual({ state: "FINALIZED" });
  });
});
