/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ManagedRequiredProjectRevisionCopy,
  ManagedRequiredSetFence,
  ManagedRequiredSetPage,
  ManagedRequiredSetPort,
} from "./managed-required-set.js";
import {
  createD1ManagedRequiredSetPort,
  enumerateManagedRequiredSet,
} from "./managed-required-set.js";
import {
  createD1ManagedTargetAssignmentPort,
  type ManagedTargetIdentity,
} from "./managed-target-assignment.js";

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

const migrationDirectory = new URL("../../../infra/d1/core/migrations/", import.meta.url);
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
  return db;
}

function insertProject(projectId: string): void {
  database.prepare(
    "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref," +
    "default_source_policy_ref,default_model_profile_ref,default_depth_profile_ref,generation,created_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(projectId, "Required set fixture", "private", "retention-1", "source-policy-1", "model-1", "depth-1", 1, CREATED_AT);
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

function requiredSetPort(): ManagedRequiredSetPort {
  return {
    async readFence(target, _asOf): Promise<ManagedRequiredSetFence> {
      const row = database.prepare(
        "WITH latest AS (SELECT project_id,MAX(event_revision) AS event_revision " +
        "FROM managed_target_assignment_event GROUP BY project_id), assignments AS (" +
        "SELECT e.* FROM managed_target_assignment_event e JOIN latest l " +
        "ON l.project_id=e.project_id AND l.event_revision=e.event_revision " +
        "WHERE e.event_kind='ASSIGN' AND e.target_namespace=? AND e.managed_instance_id=? " +
        "AND e.managed_generation=?) " +
        "SELECT (SELECT generation FROM orientation_authority_epoch WHERE singleton=1) AS authority_revision," +
        "COUNT(a.project_id) AS assigned_project_count," +
        "COALESCE(SUM(CASE WHEN p.project_id IS NULL OR p.generation<>a.project_generation " +
        "OR o.principal_ref<>a.project_owner_principal_ref THEN 1 ELSE 0 END),0) AS stale_assignment_count," +
        "COALESCE(SUM(CASE WHEN a.target_profile_identity_sha256<>? THEN 1 ELSE 0 END),0) AS profile_mismatch_count " +
        "FROM assignments a LEFT JOIN project p ON p.project_id=a.project_id " +
        "LEFT JOIN project_owner o ON o.project_id=a.project_id",
      ).get(
        target.namespace,
        target.managed_instance_id,
        target.managed_generation,
        target.target_profile_identity_sha256,
      ) as unknown as ManagedRequiredSetFence;
      return row;
    },
    async readPage(input): Promise<ManagedRequiredSetPage> {
      const authority = database.prepare(
        "SELECT generation FROM orientation_authority_epoch WHERE singleton=1",
      ).get() as { generation: number };
      const after = input.after;
      const rows = database.prepare(
        "WITH latest AS (SELECT project_id,MAX(event_revision) AS event_revision " +
        "FROM managed_target_assignment_event GROUP BY project_id), assignments AS (" +
        "SELECT e.* FROM managed_target_assignment_event e JOIN latest l " +
        "ON l.project_id=e.project_id AND l.event_revision=e.event_revision " +
        "WHERE e.event_kind='ASSIGN' AND e.target_namespace=?1 AND e.managed_instance_id=?2 " +
        "AND e.managed_generation=?3 AND e.target_profile_identity_sha256=?4) " +
        "SELECT a.event_revision AS assignment_revision,p.project_id,p.generation AS project_generation," +
        "a.project_owner_principal_ref,a.target_namespace AS namespace,a.managed_instance_id," +
        "a.managed_generation,a.target_profile_identity_sha256," +
        "'project:'||p.project_id||':generation:'||m.membership_generation AS project_membership_id," +
        "s.source_id,sr.source_revision_ref,s.head_rev AS source_head_revision_ref," +
        "s.source_namespace_id,s.source_owner_system_id,s.ownership_mode AS source_ownership_mode,"+
        "sr.source_owner_generation,"+
        "own.ownership_record_revision AS source_ownership_record_revision,"+
        "own.status AS source_owner_status,ap.revision AS source_admission_policy_revision,"+
        "ap.source_class AS source_admission_policy_source_class,d.source_class AS source_admission_decision_source_class,"+
        "s.source_class,"+
        "sr.content_sha256 AS source_revision_content_sha256,sr.normalized_artifact_ref,sr.purge_state,"+
        "d.decision AS admission_decision,d.decision_receipt_ref AS admission_decision_receipt_ref,"+
        "d.decision_sha256 AS admission_decision_sha256,d.expires_at AS admission_decision_expires_at,"+
        "d.disclosure_ceiling AS admission_disclosure_ceiling,"+
        "rp.policy_ref AS project_owner_read_policy_ref,rp.generation AS project_owner_read_policy_generation,"+
        "rp.state AS project_owner_read_policy_state,"+
        "rp.disclosure_ceiling AS project_owner_read_policy_disclosure_ceiling,"+
        "rp.expires_at AS project_owner_read_policy_expires_at,"+
        "m.membership_generation,m.valid_from AS membership_valid_from,"+
        "m.valid_to AS membership_valid_to " +
        "FROM assignments a JOIN project p ON p.project_id=a.project_id AND p.generation=a.project_generation " +
        "JOIN project_owner po ON po.project_id=p.project_id AND po.principal_ref=a.project_owner_principal_ref " +
        "JOIN project_source_membership m ON m.project_id=p.project_id AND m.membership_generation=p.generation " +
        "AND m.valid_from<=?5 " +
        "AND (m.valid_to IS NULL OR ?6<m.valid_to) " +
        "JOIN source s ON s.source_id=m.source_id " +
        "JOIN source_revision sr ON sr.source_revision_ref=s.head_rev AND sr.source_id=s.source_id " +
        "AND sr.source_owner_generation=s.source_owner_generation AND sr.purge_state='LIVE' " +
        "JOIN source_namespace_ownership own ON own.source_namespace_id=s.source_namespace_id " +
        "AND own.owner_system_id=s.source_owner_system_id AND own.source_owner_generation=sr.source_owner_generation " +
        "AND own.status='ACTIVE' " +
        "JOIN source_admission_policy ap ON ap.source_namespace_id=own.source_namespace_id " +
        "AND ap.revision=own.source_admission_policy_revision " +
        "JOIN source_admission_decision d ON d.source_revision_ref=sr.source_revision_ref " +
        "AND d.source_namespace_id=s.source_namespace_id AND d.owner_system_id=s.source_owner_system_id " +
        "AND d.source_owner_generation=sr.source_owner_generation AND d.decision='ADMITTED' " +
        "AND d.source_class=ap.source_class AND (d.expires_at IS NULL OR julianday(d.expires_at)>julianday(?5)) " +
        "AND d.decision_receipt_ref=(SELECT chosen.decision_receipt_ref FROM source_admission_decision chosen " +
        "WHERE chosen.source_revision_ref=sr.source_revision_ref AND chosen.decision='ADMITTED' " +
        "ORDER BY chosen.created_at DESC,chosen.decision_receipt_ref DESC LIMIT 1) " +
        "JOIN scope_read_policy rp ON rp.source_namespace_id=s.source_namespace_id " +
        "AND rp.principal_ref=a.project_owner_principal_ref AND rp.client_class='owner_pwa' AND rp.state='ACTIVE' " +
        "AND julianday(rp.expires_at)>julianday(?5) " +
        "WHERE (?7 IS NULL OR p.project_id>?7 OR (p.project_id=?8 AND (s.source_id>?9 OR " +
        "(s.source_id=?10 AND (m.membership_generation>?11 OR " +
        "(m.membership_generation=?12 AND sr.source_revision_ref>?13)))))) " +
        "AND json_type(ap.allowed_use_json)='array' AND json_type(ap.allowed_ownership_modes_json)='array' " +
        "AND EXISTS (SELECT 1 FROM json_each(ap.allowed_use_json) WHERE value='research') " +
        "AND EXISTS (SELECT 1 FROM json_each(ap.allowed_ownership_modes_json) WHERE value=s.ownership_mode) " +
        "AND json_type(d.allowed_use_json)='array' AND json_type(rp.allowed_use_json)='array' " +
        "AND EXISTS (SELECT 1 FROM json_each(d.allowed_use_json) WHERE value='research') " +
        "AND d.disclosure_ceiling=rp.disclosure_ceiling " +
        "AND NOT EXISTS (SELECT 1 FROM json_each(d.allowed_use_json) used WHERE NOT EXISTS " +
        "(SELECT 1 FROM json_each(rp.allowed_use_json) permitted WHERE permitted.value=used.value)) " +
        "ORDER BY p.project_id,s.source_id,m.membership_generation,sr.source_revision_ref LIMIT ?14",
      ).all(
        input.target.namespace,
        input.target.managed_instance_id,
        input.target.managed_generation,
        input.target.target_profile_identity_sha256,
        input.as_of,
        input.as_of,
        after?.project_id ?? null,
        after?.project_id ?? null,
        after?.source_id ?? null,
        after?.source_id ?? null,
        after?.membership_generation ?? null,
        after?.membership_generation ?? null,
        after?.source_revision_ref ?? null,
        input.limit,
      ) as unknown as ManagedRequiredProjectRevisionCopy[];
      const last = rows.at(-1);
      return {
        authority_revision: authority.generation,
        rows,
        next_cursor: rows.length === input.limit && last !== undefined
          ? {
            project_id: last.project_id,
            source_id: last.source_id,
            membership_generation: last.membership_generation,
            source_revision_ref: last.source_revision_ref,
          }
          : null,
      };
    },
  };
}

function currentEpoch(): number {
  return (database.prepare(
    "SELECT generation FROM orientation_authority_epoch WHERE singleton=1",
  ).get() as { generation: number }).generation;
}

function d1CoreDatabase(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: SQLInputValue[]) {
          const statement = database.prepare(sql);
          return {
            async first<T>(): Promise<T | null> {
              return (statement.get(...values) ?? null) as T | null;
            },
            async all<T>(): Promise<D1Result<T>> {
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
      assigned_project_count: 2,
      project_revision_copy_count: 2,
      authority_revision_before: receipt.authority_revision_after,
    });
    expect(copies.map((copy) => copy.project_membership_id)).toEqual([
      "project:project-1:generation:1",
      "project:project-2:generation:1",
    ]);
    expect(copies.every((copy) => copy.source_revision_ref === SOURCE_REVISION)).toBe(true);
    expect(copies.every((copy) => copy.namespace === "eliotr" && copy.source_namespace_id === SOURCE_NAMESPACE)).toBe(true);
    expect(copies.every((copy) => copy.source_class === SOURCE_CLASS)).toBe(true);
    expect(receipt.required_set_digest).toMatch(/^[a-f0-9]{64}$/u);
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

  it("detects a project-generation change that makes an assignment stale", async () => {
    database.prepare("UPDATE project SET generation=2 WHERE project_id='project-2'").run();
    await expect(enumerateManagedRequiredSet(requiredSetPort(), {
      target: TARGET,
      as_of: AS_OF,
      on_copy: () => undefined,
    })).rejects.toMatchObject({ code: "MANAGED_REQUIRED_SET_ASSIGNMENT_STALE" });
  });
});
