/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_DIRECTORY = fileURLToPath(new URL("../../../infra/d1/core/migrations/", import.meta.url));
const FINAL_MIGRATION = "0146_stable_project_membership_and_delegation.sql";
const PROJECT_DELTA = "project-delta";
const PROJECT_SCOPE = "project-scope";
const OWNER_DELTA = "owner-delta";
const OWNER_SCOPE = "owner-scope";
const DEPLOYMENT_DELTA = "deploy-delta";
const DEPLOYMENT_SCOPE = "deploy-scope";
const SERVICE = "service-1.access";
const ISSUER = "https://example.cloudflareaccess.com";
const CREATED_AT = "2026-10-14T20:00:00.000Z";
const SCOPE_EXPIRES_AT = "2099-12-31T23:59:59.000Z";
const DELEGATION_EXPIRES_AT = "2100-12-31T23:59:59.000Z";

function insertProject(database: DatabaseSync, projectId: string, title: string,
  generation: number, membershipGeneration: number, owner: string, deployment: string): void {
  database.prepare(
    "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
    "default_model_profile_ref,default_depth_profile_ref,generation,membership_generation,created_at) " +
    "VALUES (?1,?2,'private','retention-default','source-policy-default','model-default','depth-default',?3,?4,?5)",
  ).run(projectId, title, generation, membershipGeneration, CREATED_AT);
  database.prepare(
    "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) " +
    "VALUES (?1,?2,?3,?4,?4)",
  ).run(projectId, owner, deployment, CREATED_AT);
}

function insertSnapshot(database: DatabaseSync, snapshotId: string): void {
  database.prepare(
    "INSERT INTO scope_snapshot(snapshot_id,revision,resolved_scope_expression_json,participant_generations_json," +
    "member_source_revision_refs_json,source_owner_generations_json,policy_authority_ref,disclosure_closure_digest," +
    "purge_ledger_revision,client_fence_ref,snapshot_digest,created_at,expires_at) " +
    "VALUES (?1,1,?2,'{}','[]','{}','policy-1',?3,0,'credential-1',?4,?5,?6)",
  ).run(snapshotId, JSON.stringify({ kind: "PROJECT", project_id: PROJECT_SCOPE }), "c".repeat(64),
    (snapshotId === "snapshot-v1" ? "d" : "e").repeat(64), CREATED_AT, SCOPE_EXPIRES_AT);
}

function insertScopeGrant(database: DatabaseSync, input: {
  readonly snapshot_id: string;
  readonly receipt: string;
  readonly provenance_version: 1 | 2;
  readonly project_generation: number;
  readonly membership_generation?: number;
  readonly deployment_generation?: string;
}): void {
  const epoch = database.prepare(
    "SELECT generation FROM orientation_authority_epoch WHERE singleton=1",
  ).get() as { generation: number };
  if (input.provenance_version === 1) {
    database.prepare(
      "INSERT INTO scope_access_grant(snapshot_id,snapshot_revision,principal_ref,client_class,credential_generation," +
      "policy_authority_ref,allowed_use_json,disclosure_ceiling,authorization_receipt_ref,state,expires_at,created_at," +
      "project_client_grant_id,project_client_grant_revision,project_client_operation,project_client_project_generation," +
      "project_client_authority_epoch) " +
      "VALUES (?1,1,?2,'trusted_agent','credential-1','policy-1','[\"research\"]','private',?3,'ACTIVE',?4,?5,"
      + "'grant-1',1,'query',?6,?7)",
    ).run(input.snapshot_id, SERVICE, input.receipt, SCOPE_EXPIRES_AT, CREATED_AT,
      input.project_generation, epoch.generation);
    return;
  }
  database.prepare(
    "INSERT INTO scope_access_grant(snapshot_id,snapshot_revision,principal_ref,client_class,credential_generation," +
    "policy_authority_ref,allowed_use_json,disclosure_ceiling,authorization_receipt_ref,state,expires_at,created_at," +
    "project_client_grant_id,project_client_grant_revision,project_client_operation,project_client_project_generation," +
    "project_client_provenance_version,project_client_membership_generation," +
    "project_client_owner_deployment_generation,project_client_authority_epoch) " +
    "VALUES (?1,1,?2,'trusted_agent','credential-1','policy-1','[\"research\"]','private',?3,'ACTIVE',?4,?5,"
    + "'grant-1',1,'query',?6,?7,?8,?9,?10)",
  ).run(input.snapshot_id, SERVICE, input.receipt, SCOPE_EXPIRES_AT, CREATED_AT,
    input.project_generation, input.provenance_version, input.membership_generation ?? null,
    input.deployment_generation ?? null, epoch.generation);
}

describe("Core 14xx stable membership and delegation migration", () => {
  it("backfills pair revisions, preserves v1, and keeps v2 authority live across title changes", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const files = readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith(".sql")).sort();
      expect(files.at(-1)).toBe(FINAL_MIGRATION);
      for (const migration of files.slice(0, -1)) {
        database.exec(readFileSync(join(MIGRATION_DIRECTORY, migration), "utf8"));
      }

      // The data snapshot predates 0146. Foreign keys are disabled only while
      // seeding these isolated legacy membership rows; the migration and SQL
      // guards execute against the complete Core schema.
      database.exec("PRAGMA foreign_keys=OFF");
      insertProject(database, PROJECT_DELTA, "Delta", 4, 7, OWNER_DELTA, DEPLOYMENT_DELTA);
      insertProject(database, PROJECT_SCOPE, "Scope", 4, 7, OWNER_SCOPE, DEPLOYMENT_SCOPE);
      database.prepare(
        "INSERT INTO project_source_membership(project_id,source_id,role,valid_from,valid_to,membership_generation) " +
        "VALUES (?1,'source-a','member','2026-01-01T00:00:00.000Z','2026-02-01T00:00:00.000Z',2)," +
        "(?1,'source-a','member','2026-02-01T00:00:00.000Z',NULL,7)," +
        "(?1,'source-b','member','2026-02-01T00:00:00.000Z',NULL,4)",
      ).run(PROJECT_DELTA);

      insertSnapshot(database, "snapshot-v1");
      const grantRecord = JSON.stringify({
        protocol: "eliotr.project-client-grant.v1",
        grant_id: "grant-1",
        project_id: PROJECT_SCOPE,
        grantor_principal_ref: OWNER_SCOPE,
        revision: 1,
        state: "ACTIVE",
        grantee: { issuer: ISSUER, authentication_method: "service_token", subject: SERVICE },
        allowed_operations: ["query"],
        ingest_namespace_ids: [],
        expires_at: DELEGATION_EXPIRES_AT,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
      });
      database.prepare(
        "INSERT INTO project_client_grant(grant_id,revision,project_id,grantor_principal_ref,grantee_issuer," +
        "grantee_method,grantee_subject,state,expires_at,idempotency_key,request_sha256,record_json,record_sha256) " +
        "VALUES ('grant-1',1,?1,?2,?3,'service_token',?4,'ACTIVE',?5,'grant-create-1',?6,?7,?8)",
      ).run(PROJECT_SCOPE, OWNER_SCOPE, ISSUER, SERVICE, DELEGATION_EXPIRES_AT,
        "a".repeat(64), grantRecord, "b".repeat(64));
      insertScopeGrant(database, { snapshot_id: "snapshot-v1", receipt: "receipt-v1",
        provenance_version: 1, project_generation: 4 });
      expect(database.prepare(
        "SELECT project_client_project_generation FROM scope_access_grant_effective WHERE snapshot_id='snapshot-v1'",
      ).get()).toMatchObject({ project_client_project_generation: 4 });

      database.exec(readFileSync(join(MIGRATION_DIRECTORY, FINAL_MIGRATION), "utf8"));

      expect(database.prepare(
        "SELECT project_client_project_generation,project_client_provenance_version," +
        "project_client_membership_generation,project_client_owner_deployment_generation " +
        "FROM scope_access_grant WHERE snapshot_id='snapshot-v1'",
      ).get()).toEqual({
        project_client_project_generation: 4,
        project_client_provenance_version: 1,
        project_client_membership_generation: null,
        project_client_owner_deployment_generation: null,
      });
      expect(database.prepare(
        "SELECT value FROM schema_state WHERE key='project_client_scope_provenance_generation'",
      ).get()).toEqual({ value: "project-client-scope-provenance-v2" });
      expect(database.prepare(
        "SELECT source_id,membership_generation,membership_id,membership_revision " +
        "FROM project_source_membership WHERE project_id=?1 ORDER BY source_id,valid_from",
      ).all(PROJECT_DELTA)).toEqual([
        { source_id: "source-a", membership_generation: 2, membership_id: '["project-delta","source-a"]', membership_revision: 1 },
        { source_id: "source-a", membership_generation: 7, membership_id: '["project-delta","source-a"]', membership_revision: 2 },
        { source_id: "source-b", membership_generation: 4, membership_id: '["project-delta","source-b"]', membership_revision: 1 },
      ]);

      insertSnapshot(database, "snapshot-v2");
      insertScopeGrant(database, { snapshot_id: "snapshot-v2", receipt: "receipt-v2",
        provenance_version: 2, project_generation: 4, membership_generation: 7,
        deployment_generation: DEPLOYMENT_SCOPE });
      expect(database.prepare(
        "SELECT project_client_provenance_version FROM scope_access_grant_effective WHERE snapshot_id='snapshot-v2'",
      ).get()).toEqual({ project_client_provenance_version: 2 });
      expect(() => database.prepare(
        "SELECT project_client_provenance_version FROM project_client_run_control_origin LIMIT 0",
      ).all()).not.toThrow();
      expect(() => database.prepare(
        "SELECT project_client_provenance_version FROM owner_machine_run_origin LIMIT 0",
      ).all()).not.toThrow();

      database.prepare("UPDATE project SET title='Scope renamed',generation=5 WHERE project_id=?1").run(PROJECT_SCOPE);
      expect(database.prepare(
        "SELECT 1 FROM scope_access_grant_effective WHERE snapshot_id='snapshot-v1'",
      ).get()).toBeUndefined();
      expect(database.prepare(
        "SELECT project_client_provenance_version FROM scope_access_grant_effective WHERE snapshot_id='snapshot-v2'",
      ).get()).toEqual({ project_client_provenance_version: 2 });
      expect(() => database.prepare(
        "UPDATE scope_access_grant SET project_client_provenance_version=2 " +
        "WHERE snapshot_id='snapshot-v1'",
      ).run()).toThrow(/CLIENT_SCOPE_IMMUTABLE/u);

      const receipt = JSON.stringify({ protocol: "eliotr.project-owner.v1",
        project_ref: { id: PROJECT_DELTA, revision: 4 }, revision: 4, title: "Delta",
        deployment_generation: DEPLOYMENT_DELTA, owner_principal_ref: OWNER_DELTA,
        source_ids: ["source-a", "source-b"] });
      database.prepare(
        "INSERT INTO project_mutation_receipt(principal_ref,idempotency_key,operation,project_id,request_sha256," +
        "response_json,response_sha256,project_revision,deployment_generation,created_at) " +
        "VALUES (?1,'delta-receipt','UPDATE',?2,?3,?4,?5,4,?6,?7)",
      ).run(OWNER_DELTA, PROJECT_DELTA, "c".repeat(64), receipt, "d".repeat(64), DEPLOYMENT_DELTA, CREATED_AT);

      database.exec("PRAGMA foreign_keys=OFF");
      expect(() => database.prepare(
        "INSERT INTO project_source_membership(project_id,source_id,role,valid_from,valid_to," +
        "membership_generation,membership_id,membership_revision) " +
        "VALUES (?1,'source-a','reviewer','2026-10-14T20:02:00.000Z',NULL,8,?2,2)",
      ).run(PROJECT_DELTA, JSON.stringify([PROJECT_DELTA, "source-a"]))).toThrow(/PROJECT_MEMBERSHIP_IDENTITY_INVALID/u);
      database.prepare("UPDATE project SET membership_generation=8 WHERE project_id=?1").run(PROJECT_DELTA);
      database.prepare(
        "UPDATE project_source_membership SET valid_to='2026-10-14T20:01:00.000Z' " +
        "WHERE project_id=?1 AND source_id='source-a' AND valid_to IS NULL",
      ).run(PROJECT_DELTA);
      database.prepare(
        "INSERT INTO project_source_membership(project_id,source_id,role,valid_from,valid_to," +
        "membership_generation,membership_id,membership_revision) " +
        "VALUES (?1,'source-a','reviewer','2026-10-14T20:01:00.000Z',NULL,8,?2,3)",
      ).run(PROJECT_DELTA, JSON.stringify([PROJECT_DELTA, "source-a"]));
      expect(database.prepare(
        "SELECT role,membership_id,membership_revision FROM project_source_membership " +
        "WHERE project_id=?1 AND source_id='source-a' AND valid_to IS NULL",
      ).get(PROJECT_DELTA)).toEqual({ role: "reviewer", membership_id: '["project-delta","source-a"]', membership_revision: 3 });

      const preservedGuards = ["project_mutation_guard_requires_cas", "project_mutation_receipt_immutable_update",
        "project_mutation_receipt_immutable_delete", "project_owner_principal_immutable",
        "orientation_project_source_membership_update", "client_scope_origin_immutable",
        "client_scope_origin_no_delete", "project_client_grant_no_update"];
      const triggerNames = new Set(database.prepare(
        "SELECT name FROM sqlite_master WHERE type=?1",
      ).all("trigger").map((row) => (row as { name: string }).name));
      for (const name of preservedGuards) expect(triggerNames.has(name)).toBe(true);
      const receiptGuard = database.prepare(
        "SELECT sql FROM sqlite_master WHERE type=?1 AND name=?2",
      ).get("trigger", "project_mutation_receipt_owner_guard") as { sql: string };
      expect(receiptGuard.sql).toContain("m.valid_to IS NULL");
      expect(receiptGuard.sql).not.toContain("membership_generation<>p.membership_generation");
      const attachmentGuard = database.prepare(
        "SELECT sql FROM sqlite_master WHERE type=?1 AND name=?2",
      ).get("trigger", "project_attachment_namespace_receipt") as { sql: string };
      expect(attachmentGuard.sql).toContain("old.valid_to IS NULL OR old.valid_to=NEW.created_at");
      expect(attachmentGuard.sql).not.toContain("old.membership_generation=p.membership_generation");
    } finally {
      database.close();
    }
  });
});
