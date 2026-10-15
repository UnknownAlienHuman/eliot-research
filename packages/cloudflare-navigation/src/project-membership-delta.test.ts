/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ProjectClientGrant } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { describe, expect, it } from "vitest";
import { authorizeProjectClientGrant } from "./client-grant-authority.js";
import { createProjectOwnerCapability } from "./project-owner-service.js";
import type { ProjectOwnerSourceAuthority } from "./project-owner-contract.js";

const PROJECT_ID = "project-a";
const OWNER = "owner-a";
const DEPLOYMENT = "deploy-stable";
const SERVICE = "service-1.access";
const ISSUER = "https://example.cloudflareaccess.com";
const MEMBERS = ["source-a", "source-b", "source-c"] as const;
const STARTED_AT = "2026-10-14T20:00:00.000Z";
const EXPIRES_AT = "2026-10-15T20:00:00.000Z";

interface MembershipRecord {
  readonly rowid: number;
  readonly source_id: string;
  readonly role: string;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly membership_generation: number;
}

function nativeD1(database: DatabaseSync) {
  const batchChanges: number[][] = [];
  const core = {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const bind = (...values: unknown[]) => {
        const parameters = values as SQLInputValue[];
        return {
          async all<T>() {
            return { success: true, results: statement.all(...parameters) as T[] };
          },
          async first<T>() {
            return (statement.get(...parameters) as T | undefined) ?? null;
          },
          async run<T>() {
            const result = statement.run(...parameters);
            return { success: true, results: [] as T[], meta: { changes: Number(result.changes) } };
          },
        };
      };
      return { bind, ...bind() };
    },
    async batch(statements: D1PreparedStatement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        const changes: number[] = [];
        for (const statement of statements) {
          const result = await statement.run();
          results.push(result);
          changes.push(Number(result.meta?.changes ?? 0));
        }
        database.exec("COMMIT");
        batchChanges.push(changes);
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { core, batchChanges };
}

function context(): AuthenticatedRequestContext {
  return {
    client_class: "trusted_agent",
    principal_ref: SERVICE,
    credential_generation: "credential-1",
    access: {
      issuer: ISSUER,
      authentication_method: "service_token",
      principal_ref: SERVICE,
      credential_generation: "credential-1",
      expires_at: EXPIRES_AT,
    },
    request: {
      url: "https://owner.example.test/project",
      headers: new Headers([["X-Eliotr-Client-Grant", "grant-1"]]),
      signal: new AbortController().signal,
    },
  } as unknown as AuthenticatedRequestContext;
}

async function insertGrant(database: DatabaseSync, revision: number, updatedAt: string): Promise<void> {
  const grant: ProjectClientGrant = {
    protocol: "eliotr.project-client-grant.v1",
    grant_id: "grant-1",
    project_id: PROJECT_ID,
    grantor_principal_ref: OWNER,
    revision,
    state: "ACTIVE",
    grantee: { issuer: ISSUER, authentication_method: "service_token", subject: SERVICE },
    allowed_operations: ["query"],
    ingest_namespace_ids: [],
    expires_at: EXPIRES_AT,
    created_at: STARTED_AT,
    updated_at: updatedAt,
  };
  const record = canonicalJson(grant);
  database.prepare(
    "INSERT INTO project_client_grant(grant_id,revision,project_id,grantor_principal_ref,grantee_issuer," +
    "grantee_method,grantee_subject,state,expires_at,record_json,record_sha256,request_sha256) " +
    "VALUES (?1,?2,?3,?4,?5,'service_token',?6,?7,?8,?9,?10,?11)",
  ).run("grant-1", revision, PROJECT_ID, OWNER, ISSUER, SERVICE, grant.state, grant.expires_at,
    record, await sha256Utf8(record), "a".repeat(64));
}

function readMembershipRows(database: DatabaseSync): MembershipRecord[] {
  return database.prepare(
    "SELECT rowid,source_id,role,valid_from,valid_to,membership_generation " +
    "FROM project_source_membership WHERE project_id=?1 ORDER BY source_id,valid_from",
  ).all(PROJECT_ID) as unknown as MembershipRecord[];
}

describe("canonical project membership delta and delegated lease", () => {
  it("keeps title edits O(1), preserves membership rows, and rejects stale project revisions", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE project (
        project_id TEXT PRIMARY KEY, title TEXT NOT NULL, default_disclosure TEXT NOT NULL,
        retention_policy_ref TEXT NOT NULL, default_source_policy_ref TEXT NOT NULL,
        default_model_profile_ref TEXT NOT NULL, default_depth_profile_ref TEXT NOT NULL,
        generation INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE project_owner (
        project_id TEXT NOT NULL, principal_ref TEXT NOT NULL, deployment_generation TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,principal_ref)
      );
      CREATE TABLE project_source_membership (
        project_id TEXT NOT NULL, source_id TEXT NOT NULL, role TEXT NOT NULL,
        valid_from TEXT NOT NULL, valid_to TEXT, membership_generation INTEGER NOT NULL,
        PRIMARY KEY(project_id,source_id,valid_from)
      );
      CREATE TABLE project_mutation_guard (
        principal_ref TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation TEXT NOT NULL,
        project_id TEXT NOT NULL, expected_revision INTEGER NOT NULL, next_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, project_client_grant_id TEXT, project_client_grant_revision INTEGER,
        client_authority_expires_at TEXT, PRIMARY KEY(principal_ref,idempotency_key)
      );
      CREATE TABLE project_mutation_receipt (
        principal_ref TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation TEXT NOT NULL,
        project_id TEXT NOT NULL, request_sha256 TEXT NOT NULL, response_json TEXT NOT NULL,
        response_sha256 TEXT NOT NULL, project_revision INTEGER NOT NULL, deployment_generation TEXT NOT NULL,
        created_at TEXT NOT NULL, project_client_grant_id TEXT, project_client_grant_revision INTEGER,
        PRIMARY KEY(principal_ref,idempotency_key)
      );
      CREATE TABLE project_client_grant (
        grant_id TEXT NOT NULL, revision INTEGER NOT NULL, project_id TEXT NOT NULL,
        grantor_principal_ref TEXT NOT NULL, grantee_issuer TEXT NOT NULL, grantee_method TEXT NOT NULL,
        grantee_subject TEXT NOT NULL, state TEXT NOT NULL, expires_at TEXT NOT NULL,
        record_json TEXT NOT NULL, record_sha256 TEXT NOT NULL, request_sha256 TEXT NOT NULL,
        PRIMARY KEY(grant_id,revision)
      );
      CREATE TABLE orientation_authority_epoch(singleton INTEGER PRIMARY KEY, generation INTEGER NOT NULL);
      INSERT INTO orientation_authority_epoch VALUES (1,1);
      INSERT INTO project VALUES (
        '${PROJECT_ID}','Initial','private','retention-a','policy-a','model-a','depth-a',1,'${STARTED_AT}'
      );
      INSERT INTO project_owner VALUES ('${PROJECT_ID}','${OWNER}','${DEPLOYMENT}','${STARTED_AT}','${STARTED_AT}');
      INSERT INTO project_source_membership VALUES
        ('${PROJECT_ID}','source-a','member','${STARTED_AT}',NULL,1),
        ('${PROJECT_ID}','source-b','member','${STARTED_AT}',NULL,1),
        ('${PROJECT_ID}','source-c','member','${STARTED_AT}',NULL,1);
      CREATE TRIGGER project_epoch AFTER UPDATE ON project BEGIN
        UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1;
      END;
      CREATE TRIGGER membership_insert_epoch AFTER INSERT ON project_source_membership BEGIN
        UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1;
      END;
      CREATE TRIGGER membership_update_epoch AFTER UPDATE ON project_source_membership BEGIN
        UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1;
      END;
      CREATE TRIGGER client_grant_epoch AFTER INSERT ON project_client_grant BEGIN
        UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1;
      END;
    `);

    let now = Date.parse(STARTED_AT);
    const native = nativeD1(database);
    const sourceAuthority: ProjectOwnerSourceAuthority = {
      eligibleSourceCte: (sourceJson, _principal, _observed, _projectId) =>
        `WITH requested(source_id) AS (SELECT value FROM json_each(${sourceJson})), ` +
        "eligible(source_id) AS (SELECT source_id FROM requested) ",
      currentMembershipsReadableGuard: () => "1",
      async eligibleCount(_db, sourceIds) { return sourceIds.length; },
      async readMembershipIds(_db, _principal, projectIds) {
        if (projectIds.length === 0) return [];
        const rows = await native.core.prepare(
          "SELECT project_id,source_id FROM project_source_membership " +
          "WHERE project_id IN (SELECT value FROM json_each(?1)) AND valid_to IS NULL ORDER BY project_id,source_id",
        ).bind(JSON.stringify(projectIds)).all<{ project_id: string; source_id: string }>();
        return rows.results ?? [];
      },
    };
    const owner = createProjectOwnerCapability({
      database: native.core,
      deployment_generation: DEPLOYMENT,
      now: () => now,
      source_authority: sourceAuthority,
    });
    const actor = { principal_ref: OWNER, credential_generation: "owner-credential" };
    await insertGrant(database, 1, STARTED_AT);
    const firstLease = await authorizeProjectClientGrant(native.core, context(),
      { operation: "query", project_id: PROJECT_ID }, () => now);
    const beforeRename = readMembershipRows(database).filter((row) => row.valid_to === null);
    now += 1_000;
    const renamed = await owner.update(actor, PROJECT_ID,
      { expected_revision: 1, title: "Renamed", source_ids: MEMBERS }, "rename-1");
    expect(renamed.revision).toBe(2);
    expect(native.batchChanges.at(-1)).toEqual([1, 1, 1, 0, 0, 1, 1]);
    expect(readMembershipRows(database).filter((row) => row.valid_to === null).map((row) => ({
      source_id: row.source_id, rowid: row.rowid, membership_generation: row.membership_generation,
    }))).toEqual(beforeRename.map((row) => ({
      source_id: row.source_id, rowid: row.rowid, membership_generation: row.membership_generation,
    })));
    expect(firstLease.project_generation).toBe(1);
    await expect(firstLease.requireCurrent()).rejects.toMatchObject({ code: "CLIENT_GRANT_AUTHORITY_CHANGED" });

    now += 1_000;
    await insertGrant(database, 2, new Date(now).toISOString());
    await expect(firstLease.requireCurrent()).rejects.toMatchObject({ code: "CLIENT_GRANT_AUTHORITY_CHANGED" });
    const secondLease = await authorizeProjectClientGrant(native.core, context(),
      { operation: "query", project_id: PROJECT_ID }, () => now);

    now += 1_000;
    const delta = await owner.update(actor, PROJECT_ID,
      { expected_revision: 2, title: "Renamed", source_ids: ["source-a", "source-b", "source-d"] }, "delta-1");
    expect(delta.revision).toBe(3);
    expect(native.batchChanges.at(-1)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    const afterDelta = readMembershipRows(database);
    const activeAfterDelta = afterDelta.filter((row) => row.valid_to === null);
    expect(activeAfterDelta.map((row) => row.source_id)).toEqual(["source-a", "source-b", "source-d"]);
    const priorA = beforeRename.find((row) => row.source_id === "source-a");
    const currentA = activeAfterDelta.find((row) => row.source_id === "source-a");
    expect(currentA).toMatchObject({ rowid: priorA?.rowid, membership_generation: 1 });
    const priorB = beforeRename.find((row) => row.source_id === "source-b");
    const currentB = activeAfterDelta.find((row) => row.source_id === "source-b");
    expect(currentB).toMatchObject({ rowid: priorB?.rowid, membership_generation: 1 });
    expect(afterDelta).toHaveLength(4);
    expect(afterDelta.filter((row) => row.valid_to !== null)).toHaveLength(1);
    expect(activeAfterDelta.find((row) => row.source_id === "source-d")).toMatchObject({
      membership_generation: 3,
    });
    await expect(secondLease.requireCurrent()).rejects.toMatchObject({ code: "CLIENT_GRANT_AUTHORITY_CHANGED" });
    database.close();
  });
});
