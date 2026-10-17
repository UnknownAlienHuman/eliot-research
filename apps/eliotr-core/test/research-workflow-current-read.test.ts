import { beforeEach, describe, expect, it } from "vitest";
import { WorkflowCheckpointStore, type StageRequest } from "@eliotr/cloudflare-workflows";
import { principal, workflowFixture } from "./research-workflow-fixture.js";

let fixture: Awaited<ReturnType<typeof workflowFixture>>;

function observeCurrentRead(database: D1Database) {
  const reads: { sql: string; row: Record<string, unknown> | null }[] = [];
  function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (property === "first") return async (...args: unknown[]) => {
          const row = await Reflect.get(target, property, target).apply(target, args) as Record<string, unknown> | null;
          if (sql.includes("LEFT JOIN research_workflow_current")) reads.push({ sql, row });
          return row;
        };
        return Reflect.get(target, property, target);
      },
    });
  }
  const db = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      return Reflect.get(target, property, target);
    },
  });
  return { db, reads };
}

beforeEach(async () => {
  fixture = await workflowFixture("current-read");
  await new WorkflowCheckpointStore(fixture.db).ensureRun(fixture.request, principal);
}, 20_000);

describe("workflow current read query boundary — real D1", () => {
  it("checks raw run identity and the current authority view with one SELECT", async () => {
    const observed = observeCurrentRead(fixture.db);
    await new WorkflowCheckpointStore(observed.db).current(fixture.request, principal);

    expect(observed.reads).toHaveLength(1);
    expect(observed.reads[0].sql).toMatch(/FROM research_workflow_run r\s+LEFT JOIN research_workflow_current current_run/u);
    expect(observed.reads[0].row).toMatchObject({
      operation_id: fixture.request.operation_id,
      current_operation_id: fixture.request.operation_id,
      current_ledger_revision: fixture.request.investigation_ref.revision,
    });
  });

  it("distinguishes an absent run row from a run excluded by current authority", async () => {
    const missingRun = { ...fixture.request, operation_id: "workflow-run-missing-current-read" } as StageRequest;
    const missing = observeCurrentRead(fixture.db);
    await expect(new WorkflowCheckpointStore(missing.db).current(missingRun, principal))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(missing.reads).toHaveLength(1);
    expect(missing.reads[0].row).toBeNull();

    await fixture.db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE principal_ref=?1")
      .bind(principal.principal_ref).run();
    const excluded = observeCurrentRead(fixture.db);
    await expect(new WorkflowCheckpointStore(excluded.db).current(fixture.request, principal))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(excluded.reads).toHaveLength(1);
    expect(excluded.reads[0].row).toMatchObject({
      operation_id: fixture.request.operation_id,
      current_operation_id: null,
      current_ledger_revision: null,
    });
  });

  it("retains principal, credential-generation, and deployment-generation fences", async () => {
    const store = new WorkflowCheckpointStore(fixture.db);
    await expect(store.current(fixture.request, { ...principal, principal_ref: "another-principal" }))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    await expect(store.current(fixture.request, { ...principal, credential_generation: "another-credential" }))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    await expect(store.current(fixture.request, { ...principal, deployment_generation: "another-deployment" }))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  });

  it("keeps cancellation ahead of a current-view miss", async () => {
    const store = new WorkflowCheckpointStore(fixture.db);
    await store.cancel(fixture.request.operation_id, principal);
    await fixture.db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE principal_ref=?1")
      .bind(principal.principal_ref).run();

    await expect(store.current(fixture.request, principal)).rejects.toMatchObject({ code: "WORKFLOW_CANCELLED" });
  });

  it("rejects a ledger head that advanced past the workflow revision", async () => {
    const head = await fixture.ledger.read(fixture.request.investigation_ref.id);
    await fixture.ledger.checkpoint(head.investigation_id, head.revision, head.checkpoint_head, principal.principal_ref,
      "current-read-external-ledger-append", fixture.request.input_manifest.object_ref, fixture.request.input_manifest.sha256);

    await expect(new WorkflowCheckpointStore(fixture.db).current(fixture.request, principal))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  });

  it("rejects a source-invalidated scope through the current authority view", async () => {
    await fixture.db.prepare("UPDATE scope_snapshot SET invalidated_at=?1, invalidation_reason='SOURCE_NOT_LIVE' WHERE snapshot_id=?2 AND revision=1")
      .bind(new Date().toISOString(), fixture.request.input_manifest.residency.scope_domain_id).run();

    await expect(new WorkflowCheckpointStore(fixture.db).current(fixture.request, principal))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  });

  it("rejects a retired current policy", async () => {
    await fixture.db.prepare("UPDATE investigation_current_policy SET state='RETIRED' WHERE policy_generation='workflow-policy'").run();
    await expect(new WorkflowCheckpointStore(fixture.db).current(fixture.request, principal))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  });

  it("rejects a revoked grant", async () => {
    await fixture.db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE principal_ref=?1")
      .bind(principal.principal_ref).run();
    await expect(new WorkflowCheckpointStore(fixture.db).current(fixture.request, principal))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  });

  it("rejects an advanced global purge revision", async () => {
    await fixture.db.prepare(`INSERT INTO purge_ledger
      (erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at)
      VALUES ('current-read-purge','${"a".repeat(64)}','COMPLETE','current-read-purge-receipt',?1)`)
      .bind(new Date().toISOString()).run();
    await expect(new WorkflowCheckpointStore(fixture.db).current(fixture.request, principal))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  });
});
