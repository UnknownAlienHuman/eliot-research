import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "./api.js";
import {
  cancelExhaustiveWorkflow, exhaustiveQueryBody, launchExhaustiveWorkflow, listExhaustiveWorkflows, readExhaustiveWorkflow,
} from "./exhaustive-workflow-api.js";
import { mergeRecoveryPage } from "./exhaustive-workflow-panel.js";

const generation = "deployment-1";
const workflow = `exhaustive-workflow-${"a".repeat(64)}`;

function envelope(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ data, trace_id: "trace-1", deployment_generation: generation }), {
    status, headers: { "content-type": "application/json" },
  });
}

function completeData(): Record<string, unknown> {
  return {
    protocol: "eliotr.exhaustive-query.v1", workflow_instance_id: workflow, workflow_status: "complete",
    job: {
      status: "COMPLETE", receipt: {
        job_id: "job-1", idempotency_key: "key-1", request_digest: "b".repeat(64),
        scope_snapshot_id: "scope-1", scope_snapshot_revision: 1, coverage_claim: "COMPLETE",
        coverage_denominator_ref: "denominator-1", denominator_shards: 2, settled_shards: 2,
        total_scanned_sections: 8, total_matches: 3, result_artifact_ref: "artifact-1", coverage_receipt_ref: "receipt-1",
      },
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("exhaustive workflow transport", () => {
  it("builds the exact exhaustive profile and accepts a launch 202", async () => {
    const fetch = vi.fn(async () => envelope({
      protocol: "eliotr.exhaustive-query.v1", workflow_instance_id: workflow, workflow_status: "queued",
    }, 202));
    vi.stubGlobal("fetch", fetch);
    const body = exhaustiveQueryBody("alpha", []);
    expect(JSON.parse(body)).toMatchObject({ product: "EXHAUSTIVE_JOB", budget_ref: "exhaustive-job-v1", max_results: 16 });
    await expect(launchExhaustiveWorkflow(body, "key-1", generation)).resolves.toMatchObject({ workflow_instance_id: workflow, workflow_status: "queued" });
    expect(fetch).toHaveBeenCalledWith("/api/v1/research/query", expect.objectContaining({ method: "POST" }));
  });

  it("requires the requested workflow and deployment identity on status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope(completeData())));
    await expect(readExhaustiveWorkflow(workflow, generation)).resolves.toMatchObject({ workflow_status: "complete", job: { status: "COMPLETE", total_matches: 3 } });
    await expect(readExhaustiveWorkflow(workflow, "deployment-2")).rejects.toMatchObject({ code: "API_GENERATION_MISMATCH" });
  });

  it("uses DELETE for server cancellation and refuses inconsistent coverage", async () => {
    const bad = completeData();
    bad.workflow_status = "running";
    bad.job = { status: "UNFINISHED", job_id: "job-1", coverage_denominator_ref: "denominator-1", denominator_shards: 2, settled_shards: 1, unsettled_shard_ids: [] };
    const fetch = vi.fn(async () => envelope(bad));
    vi.stubGlobal("fetch", fetch);
    await expect(readExhaustiveWorkflow(workflow, generation)).rejects.toMatchObject({ code: "RESEARCH_WORKFLOW_RESPONSE_INVALID" });
    const cancelFetch = vi.fn(async () => envelope({ protocol: "eliotr.exhaustive-query.v1", workflow_instance_id: workflow, workflow_status: "terminated" }));
    vi.stubGlobal("fetch", cancelFetch);
    await expect(cancelExhaustiveWorkflow(workflow, generation)).resolves.toMatchObject({ workflow_status: "terminated" });
    expect(cancelFetch).toHaveBeenCalledWith(`/api/v1/research/query/${workflow}`, expect.objectContaining({ method: "DELETE" }));
  });

  it("does not accept an unknown status or foreign workflow id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope({ protocol: "eliotr.exhaustive-query.v1", workflow_instance_id: workflow, workflow_status: "mystery" })));
    await expect(readExhaustiveWorkflow(workflow, generation)).rejects.toBeInstanceOf(ApiRequestError);
    await expect(readExhaustiveWorkflow("exhaustive-workflow-invalid", generation)).rejects.toMatchObject({ code: "RESEARCH_WORKFLOW_RESPONSE_INVALID" });
  });

  it("requires the complete receipt identity before showing complete coverage", async () => {
    const missing = completeData();
    delete ((missing.job as Record<string, unknown>).receipt as Record<string, unknown>).request_digest;
    vi.stubGlobal("fetch", vi.fn(async () => envelope(missing)));
    await expect(readExhaustiveWorkflow(workflow, generation)).rejects.toMatchObject({ code: "RESEARCH_WORKFLOW_RESPONSE_INVALID" });
  });

  it("rejects the obsolete flattened complete job shape", async () => {
    const flattened = completeData();
    flattened.job = {
      status: "COMPLETE", job_id: "job-1", idempotency_key: "key-1", request_digest: "b".repeat(64),
      scope_snapshot_id: "scope-1", scope_snapshot_revision: 1, coverage_claim: "COMPLETE",
      coverage_denominator_ref: "denominator-1", denominator_shards: 2, settled_shards: 2,
      total_scanned_sections: 8, total_matches: 3, result_artifact_ref: "artifact-1", coverage_receipt_ref: "receipt-1",
    };
    vi.stubGlobal("fetch", vi.fn(async () => envelope(flattened)));
    await expect(readExhaustiveWorkflow(workflow, generation)).rejects.toMatchObject({ code: "RESEARCH_WORKFLOW_RESPONSE_INVALID" });
  });

  it("decodes recent workflow summaries without importing private job data", async () => {
    const fetch = vi.fn(async () => envelope({
      protocol: "eliotr.exhaustive-workflow-page.v1",
      items: [{ workflow_instance_id: workflow, workflow_status: "running", job_state: "PENDING",
        binding_state: "BOUND", created_at: "2026-09-09T12:00:00.000Z", expires_at: "2026-09-09T13:00:00.000Z",
        recoverable: true, cancelable: true }], next_cursor: "cursor-2",
    }));
    vi.stubGlobal("fetch", fetch);
    await expect(listExhaustiveWorkflows(20, undefined, generation)).resolves.toMatchObject({
      protocol: "eliotr.exhaustive-workflow-page.v1", items: [{ workflow_instance_id: workflow, recoverable: true, cancelable: true }], next_cursor: "cursor-2",
    });
    expect(fetch).toHaveBeenCalledWith("/api/v1/research/query/jobs?limit=20", expect.anything());
  });

  it("rejects a recent workflow row with a missing binding flag", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope({
      protocol: "eliotr.exhaustive-workflow-page.v1",
      items: [{ workflow_instance_id: workflow, workflow_status: "running", created_at: "2026-09-09T12:00:00.000Z", recoverable: true, cancelable: true }],
    })));
    await expect(listExhaustiveWorkflows(20, undefined, generation)).rejects.toMatchObject({ code: "RESEARCH_WORKFLOW_RESPONSE_INVALID" });
  });

  it("bounds recovery pages and stops pagination at the local cap", () => {
    const first = { workflow_instance_id: workflow, workflow_status: "running" as const, job_state: "PENDING" as const,
      binding_state: "BOUND" as const, created_at: "2026-09-09T12:00:00.000Z", recoverable: true, cancelable: true };
    const second = { ...first, workflow_instance_id: `exhaustive-workflow-${"c".repeat(64)}` };
    const page = { protocol: "eliotr.exhaustive-workflow-page.v1" as const, deployment_generation: generation,
      items: [first, second], next_cursor: "cursor-next" };
    const merged = mergeRecoveryPage(new Map(), page, false, 1);
    expect([...merged.items.keys()]).toEqual([workflow]);
    expect(merged).toMatchObject({ added: 1, capped: true, nextCursor: undefined });
  });

  it("keeps an honest cursor when a filtered page adds no new recovery item", () => {
    const item = { workflow_instance_id: workflow, workflow_status: "running" as const, job_state: "PENDING" as const,
      binding_state: "BOUND" as const, created_at: "2026-09-09T12:00:00.000Z", recoverable: true, cancelable: true };
    const existing = new Map([[workflow, item]]);
    const page = { protocol: "eliotr.exhaustive-workflow-page.v1" as const, deployment_generation: generation,
      items: [], next_cursor: "cursor-after-empty" };
    const merged = mergeRecoveryPage(existing, page, true);
    expect(merged.items.size).toBe(1);
    expect(merged.added).toBe(0);
    expect(merged.nextCursor).toBe("cursor-after-empty");
    expect(merged.capped).toBe(false);
  });
});
