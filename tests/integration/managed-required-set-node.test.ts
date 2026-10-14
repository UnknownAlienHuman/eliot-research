/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ManagedRequiredProjectRevisionCopy,
} from "../../packages/cloudflare-projection/src/managed-required-set.js";
import {
  createD1ManagedRequiredSetPort,
  enumerateManagedRequiredSet,
} from "../../packages/cloudflare-projection/src/managed-required-set.js";
import {
  createD1ManagedTargetAssignmentPort,
  type ManagedTargetIdentity,
} from "../../packages/cloudflare-projection/src/managed-target-assignment.js";

const TARGET: ManagedTargetIdentity = Object.freeze({
  namespace: "eliotr",
  managed_instance_id: "private-prose-g2",
  managed_generation: "g2-qwen3-2026-09-03",
  target_profile_identity_sha256: "a".repeat(64),
});
const AS_OF = "2026-10-14T12:00:00.000Z";
const CREATED_AT = "2026-10-14T11:00:00.000Z";
const SOURCE_NAMESPACE = "canonical-source-ns-1";
const SOURCE_CLASS = "unknown-eligible-source-class";
const SOURCE_ID = "source-1";
const SOURCE_REVISION = "revision-1";
const OWNER_GENERATION = "owner-generation-1";
const DECISION_REF = "decision-1";
const DB_DIGEST = "b".repeat(64);
const RESIDENCY_DIGEST = "c".repeat(64);
const PROFILE_DIGEST = "d".repeat(64);

const migrationDirectory = new URL("../../infra/d1/core/migrations/", import.meta.url);
let database: DatabaseSync;

function createMigratedCore(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => /^\d+_.*\.sql$/u.test(name))
    .sort();
  for (const migration of migrations) {
    db.exec(readFileSync(new URL(migration, migrationDirectory), "utf8"));
  }
  ensureProjectMembershipGenerationColumn(db);
  return db;
}

function createCoreBeforeAssignmentCurrent(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => /^\d+_.*\.sql$/u.test(name) && name < "0143_managed_target_assignment_current.sql")
    .sort();
  for (const migration of migrations) {
    db.exec(readFileSync(new URL(migration, migrationDirectory), "utf8"));
  }
  ensureProjectMembershipGenerationColumn(db);
  return db;
}

function ensureProjectMembershipGenerationColumn(db: DatabaseSync): void {
  // The assigned branch may be validated before the reserved 0142 lands.
  // Model its exact additive column contract in this in-memory fixture only;
  // when 0142 is present, its own schema/backfill is exercised instead.
  const projectColumns = db.prepare("PRAGMA table_info(project)").all() as { name: string }[];
  if (!projectColumns.some((column) => column.name === "membership_generation")) {
    db.exec(
      "ALTER TABLE project ADD COLUMN membership_generation INTEGER NOT NULL DEFAULT 1 " +
      "CHECK (membership_generation > 0)",
    );
    db.exec("UPDATE project SET membership_generation=generation");
  }
}

function insertProject(projectId: string): void {
  database.prepare(
    "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref," +
    "default_source_policy_ref,default_model_profile_ref,default_depth_profile_ref,generation," +
    "membership_generation,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(projectId, "Required set fixture", "private", "retention-1", "source-policy-1", "model-1", "depth-1", 1, 1, CREATED_AT);
  database.prepare(
    "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) " +
    "VALUES (?,?,?,?,?)",
  ).run(projectId, "owner-principal-1", "deployment-1", CREATED_AT, CREATED_AT);
}

function insertAssignment(projectId: string, expectedRevision = 0): void {
  const nextRevision = expectedRevision + 1;
  database.prepare(
    "INSERT INTO managed_target_assignment_event(project_id,event_revision,expected_event_revision," +
    "event_kind,project_generation,project_owner_principal_ref,target_namespace,managed_instance_id," +
    "managed_generation,target_profile_identity_sha256,previous_assignment_revision,actor_kind," +
    "actor_principal_ref,authorization_receipt_ref,created_at) " +
    "VALUES (?,?,?,'ASSIGN',1,'owner-principal-1',?,?,?, ?,NULL,'OWNER','owner-principal-1',?,?)",
  ).run(
    projectId,
    nextRevision,
    expectedRevision,
    TARGET.namespace,
    TARGET.managed_instance_id,
    TARGET.managed_generation,
    TARGET.target_profile_identity_sha256,
    `assignment-receipt-${projectId}`,
    CREATED_AT,
  );
}

function insertMembership(projectId: string, sourceId = SOURCE_ID): void {
  database.prepare(
    "INSERT INTO project_source_membership(project_id,source_id,role,valid_from,valid_to,membership_generation) " +
    "VALUES (?,?,?, ?,NULL,1)",
  ).run(projectId, sourceId, "member", "2026-10-01T00:00:00.000Z");
}

function seedCanonicalEligibleSource(): void {
  database.prepare(
    "INSERT INTO source_namespace_ownership(source_namespace_id,ownership_record_revision,owner_system_id," +
    "owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,created_at) " +
    "VALUES (?,?,?,?,?,1,'ACTIVE',?)",
  ).run(SOURCE_NAMESPACE, 1, "owner-system-1", "incarnation-1", OWNER_GENERATION, CREATED_AT);
  database.prepare(
    "INSERT INTO source_admission_policy(source_namespace_id,revision,authorized_principal_refs_json," +
    "allowed_ownership_modes_json,source_class,assurance_ceiling,instruction_taint,allowed_effects," +
    "allowed_use_json,disclosure_ceiling,license_policy_ref,default_storage_policy," +
    "default_residency_profile_id,default_retention_policy_id,minimum_quality_state,created_at) " +
    "VALUES (?,1,'[\"owner-principal-1\"]','[\"immutable_import\"]',?,'QUALIFIED'," +
    "'DATA_ONLY','READ_ONLY','[\"research\"]','private','license-1','storage-1','residency-1'," +
    "'retention-1','standard',?)",
  ).run(SOURCE_NAMESPACE, SOURCE_CLASS, CREATED_AT);
  database.prepare(
    "INSERT INTO scope_read_policy(source_namespace_id,principal_ref,client_class,policy_ref,generation," +
    "allowed_use_json,disclosure_ceiling,state,expires_at,created_at) VALUES (?,?,'owner_pwa','owner-read-1',1,?," +
    "'private','ACTIVE','2026-10-15T00:00:00.000Z',?)",
  ).run(SOURCE_NAMESPACE, "owner-principal-1", '["research"]', CREATED_AT);
  database.prepare(
    "INSERT INTO bundle_ingest_operation(operation_id,principal_ref,origin_authentication_receipt_ref," +
    "idempotency_key,input_fingerprint,manifest_sha256,manifest_json,file_hashes_json,total_bytes," +
    "source_namespace_id,owner_system_id,source_owner_generation,source_revision_ref,source_id," +
    "expected_head_revision_ref,residency_key_json,residency_key_digest,policy_revision," +
    "policy_snapshot_json,policy_snapshot_sha256,candidate_id,staging_session_ref,qualification_report_ref," +
    "decision_receipt_ref,state,created_at,updated_at,expires_at) " +
    "VALUES ('ingest-1','owner-principal-1','credential-1','ingest-idem-1',?,?,?,?,1,?,?,?,?,?,NULL,'{}',?,1,'{}',?," +
    "'candidate-1','staging-1','qualification-1:1',?,'AUTHORIZED',?,?,?)",
  ).run(
    DB_DIGEST,
    DB_DIGEST,
    '{"protocol":"eliotr.normalized.v1"}',
    '{"content.md":"' + DB_DIGEST + '"}',
    SOURCE_NAMESPACE,
    "owner-system-1",
    OWNER_GENERATION,
    SOURCE_REVISION,
    SOURCE_ID,
    RESIDENCY_DIGEST,
    PROFILE_DIGEST,
    DECISION_REF,
    CREATED_AT,
    CREATED_AT,
    "2026-10-15T00:00:00.000Z",
  );
  const decisionJson = JSON.stringify({ decision: "ADMITTED", source_revision_ref: SOURCE_REVISION });
  database.prepare(
    "INSERT INTO source_admission_decision(decision_receipt_ref,operation_id,source_namespace_id," +
    "owner_system_id,source_owner_generation,source_revision_ref,origin_authentication_receipt_ref," +
    "source_class,assurance_ceiling,instruction_taint,allowed_effects,object_residency_key_digest," +
    "allowed_use_json,disclosure_ceiling,license_policy_ref,decision,reason_codes_json,decision_json," +
    "decision_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    DECISION_REF,
    "ingest-1",
    SOURCE_NAMESPACE,
    "owner-system-1",
    OWNER_GENERATION,
    SOURCE_REVISION,
    "credential-1",
    SOURCE_CLASS,
    "QUALIFIED",
    "DATA_ONLY",
    "READ_ONLY",
    RESIDENCY_DIGEST,
    '["research"]',
    "private",
    "license-1",
    "ADMITTED",
    "[]",
    decisionJson,
    "e".repeat(64),
    CREATED_AT,
  );
  database.prepare(
    "INSERT INTO source(source_id,source_namespace_id,source_owner_system_id,source_owner_generation," +
    "ownership_mode,kind,title,default_storage_policy,default_residency_profile_id,source_class," +
    "license_policy_ref,default_retention_policy_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    SOURCE_ID,
    SOURCE_NAMESPACE,
    "owner-system-1",
    OWNER_GENERATION,
    "immutable_import",
    "text/markdown",
    "Source fixture",
    "storage-1",
    "residency-1",
    SOURCE_CLASS,
    "license-1",
    "retention-1",
    CREATED_AT,
  );
  database.prepare(
    "INSERT INTO source_revision(source_revision_ref,source_id,source_owner_generation,content_sha256," +
    "object_residency_key_digest,normalized_artifact_ref,captured_at,parser_profile_generation," +
    "quality_state,purge_state,currentness_state,source_view_ref,admitted_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,'LIVE','current_confirmed',?,?)",
  ).run(
    SOURCE_REVISION,
    SOURCE_ID,
    OWNER_GENERATION,
    DB_DIGEST,
    RESIDENCY_DIGEST,
    "normalized-1",
    CREATED_AT,
    "parser-1",
    "standard",
    "source-view-1",
    CREATED_AT,
  );

  database.prepare(
    "INSERT INTO operation_intent(intent_id,revision,operation_kind,principal_ref,idempotency_key," +
    "payload_ref,policy_decision_ref,created_at) VALUES ('ingest-intent-1',1,'INGEST',?,'ingest-intent-key-1',?,?,?)",
  ).run("owner-principal-1", "ingest-1", DECISION_REF, CREATED_AT);
  database.prepare(
    "INSERT INTO operation_attempt(attempt_id,intent_id,intent_revision,attempt_number,state,started_at,ended_at) " +
    "VALUES ('ingest-attempt-1','ingest-intent-1',1,1,'SUCCEEDED',?,?)",
  ).run(CREATED_AT, CREATED_AT);
  database.prepare(
    "INSERT INTO operation_receipt(receipt_id,revision,intent_id,intent_revision,attempt_id,outcome," +
    "output_refs_json,readback_receipt_refs_json,reconciliation_required,reason_codes_json,created_at) " +
    "VALUES ('ingest-receipt-1',1,'ingest-intent-1',1,'ingest-attempt-1','SUCCEEDED',?,?,0,'[]',?)",
  ).run('["ingest-1","revision-1"]', '["decision-1"]', CREATED_AT);
  database.prepare(
    "INSERT INTO operation_intent(intent_id,revision,operation_kind,principal_ref,idempotency_key," +
    "payload_ref,policy_decision_ref,created_at) VALUES ('projection-intent-1',1,'PROJECTION',?,'projection-key-1',?,?,?)",
  ).run("owner-principal-1", SOURCE_REVISION, DECISION_REF, CREATED_AT);
  database.prepare(
    "INSERT INTO outbox(outbox_id,intent_id,intent_revision,topic,payload_ref,payload_sha256,state," +
    "attempts,next_attempt_at,lease_generation,created_at,updated_at) " +
    "VALUES ('projection-outbox-1','projection-intent-1',1,'source.revision.admitted',?,?,'PENDING',0,0,0,?,?)",
  ).run(SOURCE_REVISION, DB_DIGEST, CREATED_AT, CREATED_AT);
  database.prepare("UPDATE source SET head_rev=? WHERE source_id=?").run(SOURCE_REVISION, SOURCE_ID);
  const bundleReceipt = JSON.stringify({ operation_id: "ingest-1", decision: "ADMITTED" });
  database.prepare(
    "UPDATE bundle_ingest_operation SET state='COMMITTED',promotion_receipt_ref='promotion-1'," +
    "bundle_receipt_json=?,bundle_receipt_sha256=?,updated_at=? WHERE operation_id='ingest-1'",
  ).run(bundleReceipt, PROFILE_DIGEST, CREATED_AT);
  database.prepare(
    "INSERT INTO bundle_ingest_commit_guard(operation_id,source_revision_ref,ingest_receipt_id," +
    "ingest_receipt_revision,projection_intent_id,projection_intent_revision,outbox_id,verified,created_at) " +
    "VALUES ('ingest-1',?,'ingest-receipt-1',1,'projection-intent-1',1,'projection-outbox-1',1,?)",
  ).run(SOURCE_REVISION, CREATED_AT);
}

function seedFixture(): void {
  insertProject("project-1");
  insertProject("project-2");
  seedCanonicalEligibleSource();
  insertMembership("project-1");
  insertMembership("project-2");
  insertAssignment("project-1");
  insertAssignment("project-2");
}

function requiredSetPort() {
  return createD1ManagedRequiredSetPort(d1CoreDatabase());
}

function currentEpoch(): number {
  return (database.prepare(
    "SELECT generation FROM orientation_authority_epoch WHERE singleton=1",
  ).get() as { generation: number }).generation;
}

interface CapturedCoreStatement {
  readonly sql: string;
  readonly values: readonly SQLInputValue[];
}

function d1CoreDatabase(options: {
  readonly failSourcePages?: boolean;
  readonly calls?: CapturedCoreStatement[];
} = {}): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: SQLInputValue[]) {
          const statement = database.prepare(sql);
          options.calls?.push({ sql, values: [...values] });
          return {
            async first<T>(): Promise<T | null> {
              return (statement.get(...values) ?? null) as T | null;
            },
            async all<T>(): Promise<D1Result<T>> {
              if (options.failSourcePages && sql.includes("JOIN project_source_membership m")) {
                return { success: false, results: [] } as unknown as D1Result<T>;
              }
              return {
                success: true,
                results: statement.all(...values) as T[],
              } as D1Result<T>;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("canonical managed required-set enumeration", () => {
  beforeAll(() => {
    database = createMigratedCore();
  });
  beforeEach(() => {
    database.exec("SAVEPOINT managed_required_set_case");
    seedFixture();
  });
  afterEach(() => {
    database.exec("ROLLBACK TO SAVEPOINT managed_required_set_case");
    database.exec("RELEASE SAVEPOINT managed_required_set_case");
  });
  afterAll(() => database.close());

  it("includes project/revision copies even when no projection job or effect exists", async () => {
    const projectionJobs = database.prepare(
      "SELECT COUNT(*) AS count FROM projection_generation WHERE source_revision_ref=?",
    ).get(SOURCE_REVISION) as { count: number };
    const effects = database.prepare(
      "SELECT COUNT(*) AS count FROM projection_managed_item_effect WHERE source_revision_ref=?",
    ).get(SOURCE_REVISION) as { count: number };
    expect(projectionJobs.count).toBe(0);
    expect(effects.count).toBe(0);

    const copies: ManagedRequiredProjectRevisionCopy[] = [];
    const receipt = await enumerateManagedRequiredSet(createD1ManagedRequiredSetPort(d1CoreDatabase()), {
      target: TARGET,
      as_of: AS_OF,
      on_copy: (copy) => { copies.push(copy); },
    });
    expect(receipt).toMatchObject({
      protocol: "eliotr.managed-required-project-revisions.v2",
      assigned_project_count: 2,
      project_revision_copy_count: 2,
      page_count: 1,
      target_fence: {
        protocol: "eliotr.managed-required-set-target-fence.v1",
        assignment_heads_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        required_set_sha256: receipt.required_set_digest,
        page_provenance_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        assigned_project_count: 2,
        project_revision_copy_count: 2,
        page_count: 1,
      },
    });
    expect(copies.map((copy) => copy.project_membership_id)).toEqual([
      "project:project-1:generation:1",
      "project:project-2:generation:1",
    ]);
    expect(copies.every((copy) => copy.source_revision_ref === SOURCE_REVISION)).toBe(true);
    expect(copies.every((copy) => copy.namespace === "eliotr" && copy.source_namespace_id === SOURCE_NAMESPACE)).toBe(true);
    expect(copies.every((copy) => copy.source_class === SOURCE_CLASS)).toBe(true);
    expect(receipt.required_set_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.target_fence.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("raises on an unsuccessful D1 page even when results is empty", async () => {
    let deliveredCopies = 0;
    await expect(enumerateManagedRequiredSet(
      createD1ManagedRequiredSetPort(d1CoreDatabase({ failSourcePages: true })),
      {
        target: TARGET,
        as_of: AS_OF,
        on_copy: () => { deliveredCopies += 1; },
      },
    )).rejects.toMatchObject({ code: "MANAGED_REQUIRED_SET_READ_FAILED" });
    expect(deliveredCopies).toBe(0);
  });

  it("does not invalidate on unrelated scope, grant, tag, or project metadata churn", async () => {
    const epochBefore = currentEpoch();
    let mutated = false;
    const receipt = await enumerateManagedRequiredSet(requiredSetPort(), {
      target: TARGET,
      as_of: AS_OF,
      on_copy() {
        if (mutated) return;
        mutated = true;
        insertProject("unrelated-project");
        database.prepare(
          "INSERT INTO scope_snapshot(snapshot_id,revision,resolved_scope_expression_json," +
          "participant_generations_json,member_source_revision_refs_json,source_owner_generations_json," +
          "policy_authority_ref,disclosure_closure_digest,purge_ledger_revision,client_fence_ref," +
          "snapshot_digest,created_at,expires_at) VALUES ('unrelated-snapshot',1,'{}','{}','[]','{}'," +
          "'orientation-policy','" + "f".repeat(64) + "',0,NULL,'" + "a".repeat(64) + "',?,?)",
        ).run(CREATED_AT, "2026-10-15T00:00:00.000Z");
        database.prepare(
          "INSERT INTO scope_access_grant(snapshot_id,snapshot_revision,principal_ref,client_class," +
          "credential_generation,policy_authority_ref,allowed_use_json,disclosure_ceiling," +
          "authorization_receipt_ref,state,expires_at,created_at) " +
          "VALUES ('unrelated-snapshot',1,'other-principal','owner_pwa','credential-1'," +
          "'orientation-policy','[\"research\"]','private','unrelated-grant','ACTIVE',?,?)",
        ).run("2026-10-15T00:00:00.000Z", CREATED_AT);
        database.prepare(
          "INSERT INTO source_tag(source_id,tag,valid_from,valid_to) VALUES (?, 'orientation-only', ?, NULL)",
        ).run(SOURCE_ID, CREATED_AT);
        database.prepare("UPDATE project SET title=?,generation=2 WHERE project_id='unrelated-project'")
          .run("Unrelated metadata edit");
      },
    });
    expect(mutated).toBe(true);
    expect(currentEpoch()).toBeGreaterThan(epochBefore);
    expect(receipt.project_revision_copy_count).toBe(2);
    expect(receipt.target_fence.assigned_project_count).toBe(2);
  });

  it("uses half-open membership validity and rejects an interleaved membership change", async () => {
    database.prepare(
      "UPDATE project_source_membership SET valid_to=? WHERE project_id='project-2' AND source_id=?",
    ).run(AS_OF, SOURCE_ID);
    const atUpperBound: ManagedRequiredProjectRevisionCopy[] = [];
    const bounded = await enumerateManagedRequiredSet(requiredSetPort(), {
      target: TARGET,
      as_of: AS_OF,
      on_copy: (copy) => { atUpperBound.push(copy); },
    });
    expect(bounded.project_revision_copy_count).toBe(1);
    expect(atUpperBound[0]?.project_id).toBe("project-1");

    database.prepare(
      "UPDATE project_source_membership SET valid_to=NULL WHERE project_id='project-2' AND source_id=?",
    ).run(SOURCE_ID);
    const copies: ManagedRequiredProjectRevisionCopy[] = [];
    await expect(enumerateManagedRequiredSet(requiredSetPort(), {
      target: TARGET,
      as_of: AS_OF,
      on_copy(copy) {
        copies.push(copy);
        if (copies.length === 1) {
          database.prepare(
            "UPDATE project_source_membership SET valid_to=? WHERE project_id='project-2' AND source_id=?",
          ).run(AS_OF, SOURCE_ID);
        }
      },
    })).rejects.toMatchObject({
      code: "MANAGED_REQUIRED_SET_FENCE_CHANGED",
    });
    // Both rows from the already-read page may be privately staged; the post-scan
    // Core epoch check withholds the digest/receipt after the interleaving.
    expect(copies).toHaveLength(2);
  });

  it("aborts when purge authority changes during the scan", async () => {
    await expect(enumerateManagedRequiredSet(requiredSetPort(), {
      target: TARGET,
      as_of: AS_OF,
      on_copy(copy) {
        if (copy.project_id === "project-1") {
          database.prepare("UPDATE source_revision SET purge_state='PURGE_REQUESTED' WHERE source_revision_ref=?")
            .run(SOURCE_REVISION);
        }
      },
    })).rejects.toMatchObject({
      code: "MANAGED_REQUIRED_SET_FENCE_CHANGED",
    });
  });

  it("aborts when the active namespace owner is revoked during the scan", async () => {
    await expect(enumerateManagedRequiredSet(requiredSetPort(), {
      target: TARGET,
      as_of: AS_OF,
      on_copy(copy) {
        if (copy.project_id === "project-1") {
          database.prepare("UPDATE source_namespace_ownership SET status='FENCED' WHERE source_namespace_id=?")
            .run(SOURCE_NAMESPACE);
        }
      },
    })).rejects.toMatchObject({
      code: "MANAGED_REQUIRED_SET_FENCE_CHANGED",
    });
  });

  it("aborts when the source head changes during the scan", async () => {
    await expect(enumerateManagedRequiredSet(requiredSetPort(), {
      target: TARGET,
      as_of: AS_OF,
      on_copy(copy) {
        if (copy.project_id === "project-1") {
          database.prepare("UPDATE source SET head_rev=NULL WHERE source_id=?").run(SOURCE_ID);
        }
      },
    })).rejects.toMatchObject({
      code: "MANAGED_REQUIRED_SET_FENCE_CHANGED",
    });
  });

  it("aborts when a current target assignment head changes during the scan", async () => {
    await expect(enumerateManagedRequiredSet(requiredSetPort(), {
      target: TARGET,
      as_of: AS_OF,
      on_copy(copy) {
        if (copy.project_id === "project-1") {
          insertProject("project-3");
          insertAssignment("project-3");
        }
      },
    })).rejects.toMatchObject({ code: "MANAGED_REQUIRED_SET_FENCE_CHANGED" });
  });

  it("aborts when current owner read policy changes during the scan", async () => {
    await expect(enumerateManagedRequiredSet(requiredSetPort(), {
      target: TARGET,
      as_of: AS_OF,
      on_copy(copy) {
        if (copy.project_id === "project-1") {
          database.prepare(
            "UPDATE scope_read_policy SET state='REVOKED' WHERE source_namespace_id=? " +
            "AND principal_ref='owner-principal-1' AND client_class='owner_pwa'",
          ).run(SOURCE_NAMESPACE);
        }
      },
    })).rejects.toMatchObject({ code: "MANAGED_REQUIRED_SET_FENCE_CHANGED" });
  });

  it("uses the Core D1 assignment port with append-only retirement and CAS", async () => {
    const before = currentEpoch();
    expect(() => database.prepare(
      "UPDATE managed_target_assignment_event SET managed_generation='other' WHERE project_id='project-1'",
    ).run()).toThrow(/MANAGED_TARGET_ASSIGNMENT_IMMUTABLE/u);
    expect(currentEpoch()).toBe(before);

    expect(() => insertAssignment("project-1", 0)).toThrow(/MANAGED_TARGET_ASSIGNMENT_CAS_CONFLICT/u);
    expect(() => database.prepare(
      "INSERT INTO managed_target_assignment_event(project_id,event_revision,expected_event_revision,event_kind," +
      "project_generation,project_owner_principal_ref,target_namespace,managed_instance_id,managed_generation," +
      "target_profile_identity_sha256,actor_kind,actor_principal_ref,authorization_receipt_ref,created_at) " +
      "VALUES ('project-1',2,1,'ASSIGN',1,'owner-principal-1',?,?,?, ?, 'OWNER','owner-principal-1','receipt-2',?)",
    ).run(TARGET.namespace, TARGET.managed_instance_id, TARGET.managed_generation,
      TARGET.target_profile_identity_sha256, CREATED_AT)).toThrow(/MANAGED_TARGET_ASSIGNMENT_ACTIVE_REQUIRES_RETIREMENT/u);

    let authorized = false;
    const port = createD1ManagedTargetAssignmentPort(d1CoreDatabase(), async (command) => {
      authorized = command.actor.kind === "OWNER" &&
        command.actor.principal_ref === command.project_owner_principal_ref;
    });
    const retired = await port.append({
      event_kind: "RETIRE",
      project_id: "project-1",
      project_generation: 1,
      project_owner_principal_ref: "owner-principal-1",
      expected_event_revision: 1,
      previous_assignment_revision: 1,
      actor: {
        kind: "OWNER",
        principal_ref: "owner-principal-1",
        authorization_receipt_ref: "retire-1",
      },
      created_at: CREATED_AT,
    });
    expect(authorized).toBe(true);
    expect(retired.event_revision).toBe(2);
    expect(database.prepare(
      "SELECT event_revision,event_kind,target_namespace FROM managed_target_assignment_current " +
      "WHERE project_id='project-1'",
    ).get()).toEqual({ event_revision: 2, event_kind: "RETIRE", target_namespace: null });
    expect(currentEpoch()).toBeGreaterThan(before);
    await expect(port.append({
      event_kind: "ASSIGN",
      project_id: "project-1",
      project_generation: 1,
      project_owner_principal_ref: "owner-principal-1",
      expected_event_revision: 1,
      actor: {
        kind: "OWNER",
        principal_ref: "owner-principal-1",
        authorization_receipt_ref: "stale-reassign-1",
      },
      created_at: "2026-10-14T12:02:00.000Z",
      target: TARGET,
    })).rejects.toMatchObject({ code: "MANAGED_TARGET_ASSIGNMENT_CAS_CONFLICT" });

    expect(() => database.prepare(
      "DELETE FROM managed_target_assignment_event WHERE project_id='project-1'",
    ).run()).toThrow(/MANAGED_TARGET_ASSIGNMENT_IMMUTABLE/u);
  });

  it("backfills one current event head and follows a later append", () => {
    const originalDatabase = database;
    const backfillDatabase = createCoreBeforeAssignmentCurrent();
    try {
      database = backfillDatabase;
      insertProject("backfill-project");
      insertAssignment("backfill-project");
      database.prepare(
        "INSERT INTO managed_target_assignment_event(project_id,event_revision,expected_event_revision," +
        "event_kind,project_generation,project_owner_principal_ref,previous_assignment_revision," +
        "actor_kind,actor_principal_ref,authorization_receipt_ref,created_at) " +
        "VALUES (?,2,1,'RETIRE',1,'owner-principal-1',1,'OWNER','owner-principal-1',?,?)",
      ).run("backfill-project", "backfill-retire", CREATED_AT);

      const migration = readFileSync(
        new URL("0143_managed_target_assignment_current.sql", migrationDirectory),
        "utf8",
      );
      backfillDatabase.exec(migration);
      expect(backfillDatabase.prepare(
        "SELECT event_revision,event_kind,target_namespace FROM managed_target_assignment_current " +
        "WHERE project_id='backfill-project'",
      ).get()).toEqual({ event_revision: 2, event_kind: "RETIRE", target_namespace: null });

      insertAssignment("backfill-project", 2);
      expect(backfillDatabase.prepare(
        "SELECT event_revision,event_kind,target_namespace FROM managed_target_assignment_current " +
        "WHERE project_id='backfill-project'",
      ).get()).toEqual({ event_revision: 3, event_kind: "ASSIGN", target_namespace: TARGET.namespace });
    } finally {
      database = originalDatabase;
      backfillDatabase.close();
    }
  });

  it("fails closed when every explicit assignment is retired", async () => {
    for (const projectId of ["project-1", "project-2"]) {
      database.prepare(
        "INSERT INTO managed_target_assignment_event(project_id,event_revision,expected_event_revision," +
        "event_kind,project_generation,project_owner_principal_ref,previous_assignment_revision," +
        "actor_kind,actor_principal_ref,authorization_receipt_ref,created_at) " +
        "VALUES (?,2,1,'RETIRE',1,'owner-principal-1',1,'OWNER','owner-principal-1',?,?)",
      ).run(projectId, `retire-${projectId}`, CREATED_AT);
    }
    await expect(enumerateManagedRequiredSet(requiredSetPort(), {
      target: TARGET,
      as_of: AS_OF,
      on_copy: () => undefined,
    })).rejects.toMatchObject({ code: "MANAGED_REQUIRED_SET_ASSIGNMENT_MISSING" });
  });

  it("uses the indexed current-head read model with a large retired event history", async () => {
    database.prepare(
      "WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<1000) " +
      "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref," +
      "default_source_policy_ref,default_model_profile_ref,default_depth_profile_ref,generation," +
      "membership_generation,created_at) " +
      "SELECT printf('history-project-%04d',n),'History fixture','private','retention-1'," +
      "'source-policy-1','model-1','depth-1',1,1,?1 FROM sequence",
    ).run(CREATED_AT);
    database.prepare(
      "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) " +
      "SELECT project_id,'owner-principal-1','deployment-1',?1,?1 FROM project " +
      "WHERE project_id LIKE 'history-project-%'",
    ).run(CREATED_AT);
    database.prepare(
      "INSERT INTO managed_target_assignment_event(project_id,event_revision,expected_event_revision," +
      "event_kind,project_generation,project_owner_principal_ref,target_namespace,managed_instance_id," +
      "managed_generation,target_profile_identity_sha256,previous_assignment_revision,actor_kind," +
      "actor_principal_ref,authorization_receipt_ref,created_at) " +
      "SELECT project_id,1,0,'ASSIGN',1,'owner-principal-1',?1,?2,?3,?4,NULL,'OWNER'," +
      "'owner-principal-1','history-assign-'||project_id,?5 FROM project " +
      "WHERE project_id LIKE 'history-project-%'",
    ).run(TARGET.namespace, TARGET.managed_instance_id, TARGET.managed_generation,
      TARGET.target_profile_identity_sha256, CREATED_AT);
    database.prepare(
      "INSERT INTO managed_target_assignment_event(project_id,event_revision,expected_event_revision," +
      "event_kind,project_generation,project_owner_principal_ref,previous_assignment_revision," +
      "actor_kind,actor_principal_ref,authorization_receipt_ref,created_at) " +
      "SELECT project_id,2,1,'RETIRE',1,'owner-principal-1',1,'OWNER','owner-principal-1'," +
      "'history-retire-'||project_id,?1 FROM project WHERE project_id LIKE 'history-project-%'",
    ).run(CREATED_AT);

    const calls: CapturedCoreStatement[] = [];
    const receipt = await enumerateManagedRequiredSet(
      createD1ManagedRequiredSetPort(d1CoreDatabase({ calls })),
      { target: TARGET, as_of: AS_OF, on_copy: () => undefined },
    );
    expect(database.prepare("SELECT COUNT(*) AS n FROM managed_target_assignment_event")
      .get()).toEqual({ n: 2002 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM managed_target_assignment_current " +
      "WHERE event_kind='ASSIGN'").get()).toEqual({ n: 2 });
    expect(receipt.assigned_project_count).toBe(2);
    expect(receipt.project_revision_copy_count).toBe(2);

    const lookup = calls.find((call) => call.sql.includes("managed_target_assignment_current h") &&
      call.sql.includes("ORDER BY a.project_id LIMIT ?5"));
    expect(lookup).toBeDefined();
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${lookup?.sql ?? ""}`)
      .all(...(lookup?.values ?? [])) as { detail: string }[];
    const details = plan.map((row) => row.detail).join(" ");
    expect(details).toContain("managed_target_assignment_current_target_idx");
    expect(details).not.toMatch(/SCAN (?:TABLE )?managed_target_assignment_event/u);
  });

  it("keeps assignment and membership current across a title-only metadata revision", async () => {
    const before = await enumerateManagedRequiredSet(requiredSetPort(), {
      target: TARGET,
      as_of: AS_OF,
      on_copy: () => undefined,
    });
    const epochBefore = currentEpoch();
    database.prepare("UPDATE project SET title=?,generation=2 WHERE project_id='project-2'")
      .run("Title-only change");
    const after = await enumerateManagedRequiredSet(requiredSetPort(), {
      target: TARGET,
      as_of: AS_OF,
      on_copy: () => undefined,
    });
    expect(currentEpoch()).toBeGreaterThan(epochBefore);
    expect(after.target_fence.assignment_heads_sha256).toBe(before.target_fence.assignment_heads_sha256);
    expect(after.required_set_digest).toBe(before.required_set_digest);
  });
});
