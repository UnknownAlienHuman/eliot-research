/**
 * #293 native authorization acceptance — D1 authority repair from 7d2bb36
 * (forward migration infra/d1/core/migrations/0084_d1_authority_expression_depth.sql).
 *
 * The 0084 migration dropped and recreated three BEFORE INSERT authority guards
 * (research_model_spend_admission_w2_guard, research_report_admission_current_guard,
 * research_workflow_checkpoint_guard) with decorrelated, depth-bounded predicates,
 * plus the disjoint scope_access_grant_effective view. Its own header states the
 * repair "is not full D1 emulation or behavioral acceptance".
 *
 * This module supplies that behavioral acceptance on real workerd D1
 * (vitest + @cloudflare/vitest-plugin, applyD1Migrations over the full forward
 * migration chain). Every probe issues direct SQL against CORE_DB, bypassing all
 * TypeScript layers, so a rejection can only come from the D1 authority itself:
 * a forged row must fail closed with the trigger's exact ABORT message and leave
 * zero durable effect.
 *
 * Scope: workerd-local D1 only. No D1(b) live-model assertions, no staging
 * deployment, no browser/native suites — those remain with S91/S92.
 */
import { describe, expect, it } from "vitest";
import {
  createWorkflowCheckpointExecutor,
  digest,
  encodeReceipt,
  readWorkflowObject,
  type StageReceipt,
} from "@eliotr/cloudflare-research";
import { faultBucket, principal, workflowFixture } from "./research-workflow-fixture.js";

const HEX64 = "0123456789abcdef".repeat(8).slice(0, 64);

function isoNow(): string {
  return new Date().toISOString();
}

async function expectRejectedWith(
  db: D1Database,
  sql: string,
  binds: unknown[],
  fragment: string,
): Promise<void> {
  let error: unknown = null;
  try {
    await db.prepare(sql).bind(...binds).run();
  } catch (cause) {
    error = cause;
  }
  expect(error, `expected D1 to reject with a message containing ${fragment}`).not.toBeNull();
  const message = error instanceof Error ? error.message : String(error);
  expect(message).toContain(fragment);
}

async function checkpointCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM research_workflow_checkpoint")
    .first<{ n: number }>();
  return row?.n ?? -1;
}

const CHECKPOINT_INSERT = `INSERT INTO research_workflow_checkpoint
  (operation_id, stage_index, request_sha256, receipt_json, receipt_sha256, ledger_event_id, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

describe("native D1 authorization acceptance (0084 / 7d2bb36)", () => {
  it("spend admission W2 guard denies an insert with no workflow authority", async () => {
    const f = await workflowFixture("auth-spend-neg");
    const now = isoNow();
    await expectRejectedWith(
      f.db,
      `INSERT INTO research_model_spend_admission
        (authorization_ref, operation_id, workflow_operation_id, stage_index, stage_attempt_ref,
         stage_request_sha256, stage_request_json, workflow_budget_receipt_ref, intent_id,
         intent_revision, intent_json, reservation_id, quote_ref, quote_json, authority_json,
         principal_ref, client_class, credential_generation, deployment_generation,
         policy_decision_ref, policy_generation, currentness_digest, scope_snapshot_id,
         scope_snapshot_revision, workflow_authorization_receipt_ref, route_ref,
         expected_deployment_json, approval_json, admission_revision, admission_sha256,
         decision_digest, max_input_bytes, max_output_bytes, expires_at, created_at)
       VALUES (${Array.from({ length: 35 }, (_, i) => `?${i + 1}`).join(", ")})`,
      [
        "auth-neg-1", "op-neg-1", "wop-neg-1", 12, "attempt-neg-1", HEX64, "{}",
        "budget-neg-1", "intent-neg-1", 1, "{}", "res-neg-1", "quote-neg-1", "{}", "{}",
        "workflow-owner", "owner_pwa", "workflow-credential", "workflow-deployment",
        "pol-neg-1", "workflow-deployment", HEX64, "workflow-scope", 1, "wfa-neg-1",
        "route-neg-1", "{}", "{}", 1, HEX64, HEX64, 1000, 1000, now, now,
      ],
      "MODEL_SPEND_ADMISSION_AUTHORITY_STALE",
    );
    const row = await f.db
      .prepare("SELECT COUNT(*) AS n FROM research_model_spend_admission")
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  }, 15_000);

  it("report admission guard denies an insert with no routing authority", async () => {
    const f = await workflowFixture("auth-report-neg");
    const now = isoNow();
    await expectRejectedWith(
      f.db,
      `INSERT INTO research_report_admission
        (decision_id, decision_revision, decision, decision_json, decision_sha256, input_json,
         input_sha256, policy_json, policy_ref, policy_revision, policy_generation,
         policy_authority_ref, policy_expires_at, operation_id, intent_id, intent_revision,
         outbox_id, principal_ref, client_class, credential_generation, idempotency_key,
         scope_snapshot_id, scope_snapshot_revision, scope_snapshot_digest,
         authorization_receipt_ref, deployment_generation, source_revision_refs_json,
         requested_output_class, purpose, disclosure_ceiling, expires_at, created_at)
       VALUES (${Array.from({ length: 32 }, (_, i) => `?${i + 1}`).join(", ")})`,
      [
        "decision-neg-1", 1, "ALLOW", "{}", HEX64, "{}", HEX64, "{}", "workflow-policy", 1,
        "workflow-deployment", "workflow-policy-authority", now, "op-neg-1", "intent-neg-1", 1,
        "outbox-neg-1", "workflow-owner", "owner_pwa", "workflow-credential", "idem-neg-1",
        "workflow-scope", 1, HEX64, "authr-neg-1", "workflow-deployment", "[]",
        "private-draft", "acceptance probe", "none", now, now,
      ],
      "REPORT_ADMISSION_AUTHORITY_STALE",
    );
    const row = await f.db
      .prepare("SELECT COUNT(*) AS n FROM research_report_admission")
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  }, 15_000);

  it("checkpoint guard denies an insert with no workflow run at all", async () => {
    const f = await workflowFixture("auth-cp-no-run");
    const now = isoNow();
    await expectRejectedWith(
      f.db,
      CHECKPOINT_INSERT,
      ["workflow-operation-ghost", 0, HEX64, "{}", HEX64, "wcp:ghost", now],
      "WORKFLOW_AUTHORITY_STALE",
    );
    expect(await checkpointCount(f.db)).toBe(0);
  }, 15_000);

  it("checkpoint guard denies a foreign operation_id", async () => {
    const f = await workflowFixture("auth-cp-foreign-op");
    const bytes = new TextEncoder().encode("stage zero bytes");
    await f.executor.execute(f.request, principal, async () => bytes);
    expect(await checkpointCount(f.db)).toBe(1);
    const now = isoNow();
    await expectRejectedWith(
      f.db,
      CHECKPOINT_INSERT,
      ["workflow-operation-foreign", 0, HEX64, "{}", HEX64, "wcp:foreign", now],
      "WORKFLOW_AUTHORITY_STALE",
    );
    expect(await checkpointCount(f.db)).toBe(1);
  }, 15_000);

  it("checkpoint guard denies a stage with no recorded attempt", async () => {
    const f = await workflowFixture("auth-cp-no-attempt");
    const bytes = new TextEncoder().encode("stage zero bytes");
    await f.executor.execute(f.request, principal, async () => bytes);
    expect(await checkpointCount(f.db)).toBe(1);
    const now = isoNow();
    await expectRejectedWith(
      f.db,
      CHECKPOINT_INSERT,
      [f.request.operation_id, 9, HEX64, "{}", HEX64, "wcp:stage9", now],
      "WORKFLOW_AUTHORITY_STALE",
    );
    expect(await checkpointCount(f.db)).toBe(1);
  }, 15_000);

  it("checkpoint replay of a committed stage cannot duplicate the row", async () => {
    const f = await workflowFixture("auth-cp-replay");
    const bytes = new TextEncoder().encode("stage zero bytes");
    await f.executor.execute(f.request, principal, async () => bytes);
    expect(await checkpointCount(f.db)).toBe(1);
    const row = await f.db
      .prepare(
        "SELECT operation_id, stage_index, request_sha256, receipt_json, receipt_sha256, ledger_event_id, created_at FROM research_workflow_checkpoint WHERE operation_id = ?1 AND stage_index = 0",
      )
      .bind(f.request.operation_id)
      .first<Record<string, unknown>>();
    expect(row).not.toBeNull();
    // Re-inserting the byte-identical row must fail closed: the valid commit
    // advanced the run (next_stage_index and ledger revision moved on), so the
    // 0084 authority guard itself rejects the replay — the PRIMARY KEY and the
    // UNIQUE ledger_event_id stand behind it as defense in depth.
    await expectRejectedWith(
      f.db,
      CHECKPOINT_INSERT,
      [
        row?.operation_id, row?.stage_index, row?.request_sha256, row?.receipt_json,
        row?.receipt_sha256, row?.ledger_event_id, row?.created_at,
      ],
      "WORKFLOW_AUTHORITY_STALE",
    );
    expect(await checkpointCount(f.db)).toBe(1);
  }, 15_000);

  it("checkpoint guard rejects a tampered receipt but accepts the valid direct write", async () => {
    // Stage 0 completes through the real executor. Stage 1 is then interrupted
    // after R2 persistence but before verification (mirrors the existing
    // recovery test), leaving attempt 1 OUTPUT_RECORDED with no checkpoint.
    // The stage-1 handler echoes the fixture's seed input bytes so the output
    // digest equals the fixture's fixed handle digest; the ledger service's
    // requireHandle demands exactly that digest. We then append the CHECKPOINT
    // ledger event through the real ledger service and issue the checkpoint
    // INSERT directly — first tampered (must fail closed), then valid (must land).
    const f = await workflowFixture("auth-cp-tamper");
    const seedBytes = await readWorkflowObject(f.bucket, f.request.input_manifest);
    const receipt0 = await f.executor.execute(f.request, principal, async () => seedBytes);
    const request1 = {
      ...f.request,
      stage: "ORIENT" as const,
      investigation_ref: receipt0.investigation_ref,
      input_manifest: receipt0.output_manifest,
    };

    let persisted = false;
    const bucket = faultBucket(f.bucket, {
      afterPut: async () => {
        persisted = true;
      },
      beforeGet: async () => {
        if (persisted) throw new Error("worker lost after R2 persistence");
      },
    });
    await expect(
      createWorkflowCheckpointExecutor(f.db, bucket, f.ports).execute(
        request1,
        principal,
        async () => seedBytes,
      ),
    ).rejects.toThrow();
    expect(await checkpointCount(f.db)).toBe(1);

    const attempt = await f.db
      .prepare(
        "SELECT attempt_ref, request_sha256, request_json, output_json, budget_receipt_ref, expected_revision, state FROM research_workflow_attempt WHERE operation_id = ?1 AND stage_index = 1",
      )
      .bind(request1.operation_id)
      .first<Record<string, unknown>>();
    expect(attempt?.state).toBe("OUTPUT_RECORDED");
    const requestSha = attempt?.request_sha256 as string;
    const output = JSON.parse(attempt?.output_json as string) as {
      object_ref: string;
      sha256: string;
    };
    // The echoed bytes make the output digest equal the fixture's handle digest.
    expect(output.sha256).toBe(await digest(seedBytes));

    // Append the CHECKPOINT ledger event via the real ledger service:
    // head revision 2 -> 3, event bound to the recorded output object.
    const eventId = `wcp:${requestSha}`;
    await f.ledger.checkpoint(
      receipt0.investigation_ref.id,
      2,
      2,
      principal.principal_ref,
      eventId,
      output.object_ref,
      output.sha256,
    );

    const now = isoNow();
    const receipt: StageReceipt = {
      protocol: "eliotr.workflow-checkpoint.v1",
      operation_id: request1.operation_id,
      stage: "ORIENT",
      request_sha256: requestSha,
      receipt_ref: eventId,
      attempt_ref: attempt?.attempt_ref as string,
      investigation_ref: { id: receipt0.investigation_ref.id, revision: 3 },
      input_manifest_ref: request1.input_manifest.object_ref,
      output_manifest: JSON.parse(attempt?.output_json as string),
      budget_receipt_ref: attempt?.budget_receipt_ref as string,
      cancellation_checked_at: now,
      engine_state: "CHECKPOINTED",
    };
    const validText = encodeReceipt(receipt);
    const validSha = await digest(new TextEncoder().encode(validText));

    // Tamper with exactly one authority field: the receipt protocol.
    // The JSON stays well-formed, so only the trigger's protocol predicate can fire.
    const tampered = { ...JSON.parse(validText), protocol: "tampered.protocol" };
    const tamperedText = JSON.stringify(tampered);
    const tamperedSha = await digest(new TextEncoder().encode(tamperedText));
    await expectRejectedWith(
      f.db,
      CHECKPOINT_INSERT,
      [request1.operation_id, 1, requestSha, tamperedText, tamperedSha, eventId, now],
      "WORKFLOW_AUTHORITY_STALE",
    );
    // Fail-closed: the aborted insert left no trace.
    expect(await checkpointCount(f.db)).toBe(1);

    // The valid direct write is accepted and reads back byte-exact.
    await f.db
      .prepare(CHECKPOINT_INSERT)
      .bind(request1.operation_id, 1, requestSha, validText, validSha, eventId, now)
      .run();
    expect(await checkpointCount(f.db)).toBe(2);
    const stored = await f.db
      .prepare(
        "SELECT receipt_json, receipt_sha256, ledger_event_id FROM research_workflow_checkpoint WHERE operation_id = ?1 AND stage_index = 1",
      )
      .bind(request1.operation_id)
      .first<Record<string, unknown>>();
    expect(stored?.receipt_json).toBe(validText);
    expect(stored?.receipt_sha256).toBe(validSha);
    expect(stored?.ledger_event_id).toBe(eventId);
  }, 30_000);

  it("effective grant view keeps legacy and delegated branches disjoint", async () => {
    // The 0084 view replaced the scope semijoin with a disjoint legacy/delegated
    // UNION ALL over unique joined keys. On fixture state (one legacy grant, no
    // delegation chain) the grant must surface exactly once — not zero times,
    // and not twice via both branches.
    const f = await workflowFixture("auth-view-disjoint");
    const count = await f.db
      .prepare("SELECT COUNT(*) AS n FROM scope_access_grant_effective")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    const rows = await f.db
      .prepare(
        "SELECT principal_ref, project_client_grant_id FROM scope_access_grant_effective",
      )
      .all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.principal_ref).toBe("workflow-owner");
    expect(rows.results[0]?.project_client_grant_id).toBeNull();
  }, 15_000);
});
