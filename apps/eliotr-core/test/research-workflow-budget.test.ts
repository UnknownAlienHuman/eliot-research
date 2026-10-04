import { describe, expect, it } from "vitest";
import { digest, type StageRequest } from "@eliotr/cloudflare-research";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import { readD1BoundedResearchWorkflowLeaseExpiry } from "../src/research-workflow-budget.js";
import { researchStageBudgetLeaseMs } from "../src/research-runtime-duration.js";
import { principal, workflowFixture } from "./research-workflow-fixture.js";

const resultBytes = () => new TextEncoder().encode("bounded stage result");

describe("research workflow D1-clock lease issuance", () => {
  it("keeps a fresh model-stage lease within both clocks and the unchanged D1 reservation trigger", async () => {
    const f = await workflowFixture("d1-clock-lease");
    let request = f.request;
    for (const stage of RESEARCH_WORKFLOW_STAGES.slice(0, 8)) {
      request = { ...request, stage };
      const receipt = await f.executor.execute(request, principal, async () => resultBytes());
      request = { ...request, investigation_ref: receipt.investigation_ref, input_manifest: receipt.output_manifest };
    }

    const stage8Request: StageRequest = { ...request, stage: "ANALYZE_BRANCHES" };
    const requestJson = JSON.stringify(stage8Request);
    const requestHash = await digest(new TextEncoder().encode(requestJson));
    const d1Clock = await f.db.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms")
      .first<{ now_ms: number }>();
    if (d1Clock === null) throw new Error("D1 clock readback is unavailable");
    const workerNowMs = d1Clock.now_ms + 1_000;
    const durationMs = researchStageBudgetLeaseMs(stage8Request.stage);
    const workerOnlyExpiry = workerNowMs + durationMs;
    const d1BoundedExpiry = await readD1BoundedResearchWorkflowLeaseExpiry(f.db, stage8Request.stage, workerNowMs);
    const d1ClockAfterIssue = await f.db.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms")
      .first<{ now_ms: number }>();
    if (d1ClockAfterIssue === null) throw new Error("D1 clock readback after issuance is unavailable");
    expect(d1BoundedExpiry).toBeGreaterThanOrEqual(d1Clock.now_ms + durationMs);
    expect(d1BoundedExpiry).toBeLessThanOrEqual(d1ClockAfterIssue.now_ms + durationMs);
    expect(d1BoundedExpiry).toBeGreaterThan(workerNowMs);
    expect(d1BoundedExpiry).toBeLessThanOrEqual(workerNowMs + 600_000);
    expect(d1BoundedExpiry).toBeLessThan(workerOnlyExpiry);

    const insertAttempt = (expiresAtMs: number) => f.db.prepare(`INSERT INTO research_workflow_attempt
      (operation_id, stage_index, request_json, request_sha256, attempt_ref, expected_revision,
       budget_receipt_ref, budget_expires_at_ms, state, output_json, created_at)
      VALUES (?1,8,?2,?3,?4,9,?5,?6,'STARTED',NULL,?7)`)
      .bind(stage8Request.operation_id, requestJson, requestHash, crypto.randomUUID(),
        `w2-budget:${stage8Request.operation_id}:${stage8Request.stage}`, expiresAtMs, new Date().toISOString())
      .run();

    await expect(insertAttempt(workerOnlyExpiry)).rejects.toThrow("WORKFLOW_STAGE_OUT_OF_ORDER");
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM research_workflow_attempt
      WHERE operation_id=?1 AND stage_index=8`).bind(stage8Request.operation_id).first<{ count: number }>())
      .toMatchObject({ count: 0 });

    await expect(insertAttempt(d1BoundedExpiry)).resolves.toMatchObject({ success: true });
    const stored = await f.db.prepare(`SELECT budget_expires_at_ms FROM research_workflow_attempt
      WHERE operation_id=?1 AND stage_index=8`).bind(stage8Request.operation_id)
      .first<{ budget_expires_at_ms: number }>();
    expect(stored?.budget_expires_at_ms).toBe(d1BoundedExpiry);
  }, 30_000);

  it("fails closed when no valid D1 clock can bound a new grant", async () => {
    const unavailable = { prepare: () => { throw new Error("D1 unavailable"); } } as unknown as D1Database;
    await expect(readD1BoundedResearchWorkflowLeaseExpiry(unavailable, "ANALYZE_BRANCHES"))
      .resolves.toBeNull();
    await expect(readD1BoundedResearchWorkflowLeaseExpiry(
      { prepare: () => ({ first: async () => ({ now_ms: Number.NaN }) }) } as unknown as D1Database,
      "ANALYZE_BRANCHES",
    )).resolves.toBeNull();
    const workerNowMs = Date.now();
    await expect(readD1BoundedResearchWorkflowLeaseExpiry(
      { prepare: () => ({ first: async () => ({ now_ms: workerNowMs + 600_000 }) }) } as unknown as D1Database,
      "ANALYZE_BRANCHES", workerNowMs,
    )).resolves.toBeNull();
  });
});
