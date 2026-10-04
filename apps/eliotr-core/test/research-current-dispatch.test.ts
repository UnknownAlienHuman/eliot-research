import { beforeAll, describe, expect, it, vi } from "vitest";
import { introspectWorkflow, reset } from "cloudflare:test";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import {
  readResearchArtifact, readResearchArtifactSection, readResearchArtifactSectionCitations,
  readResearchRunHistory, readResearchRunStatus, startResearchRun,
} from "../../eliotr-pwa/src/research-run-api.js";
import { db, runtime, verifier } from "./orientation-fixture.js";
import { prepareCurrentDispatchFixture } from "./research-current-dispatch-fixture.js";
import { handleHttp } from "../src/http.js";
import { SERVER_OWNED_SEMANTIC_HANDLER_GENERATION } from "../src/research-stage-handlers.js";

let fixture: Awaited<ReturnType<typeof prepareCurrentDispatchFixture>>;
beforeAll(async () => {
  await reset();
  fixture = await prepareCurrentDispatchFixture(runtime);
});

async function durableState(operationId: string) {
  const checkpoints = await db.prepare("SELECT stage_index,receipt_json FROM research_workflow_checkpoint WHERE operation_id=?1 ORDER BY stage_index")
    .bind(operationId).all<{ stage_index: number; receipt_json: string }>();
  const attempts = await db.prepare("SELECT stage_index,state FROM research_workflow_attempt WHERE operation_id=?1 ORDER BY stage_index")
    .bind(operationId).all<{ stage_index: number; state: string }>();
  const models = await db.prepare("SELECT state,receipt_sha256,output_sha256,readback_sha256 FROM research_model_attempt ORDER BY operation_kind")
    .all<{ state: string; receipt_sha256: string; output_sha256: string; readback_sha256: string }>();
  const outbox = await db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE topic='research.workflow.checkpoint.v1'").first<number>("n");
  const ledger = await db.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_event WHERE kind='CHECKPOINT'").first<number>("n");
  if (outbox === null || ledger === null) throw new Error("durable checkpoint readback missing");
  return { checkpoints: checkpoints.results, attempts: attempts.results, models: models.results, outbox, ledger };
}

describe("HTTP-created current semantic run on the native Workflow binding", () => {
  it("automatically completes all stages, materializes verified evidence and reopens/replays without another model call", async () => {
    // Only the existing provider boundary is controlled. Workflow creation,
    // entrypoint, native steps, model settlement and D1/R2 readback are real.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === "string" && input.startsWith("/api/v1/")) {
        return handleHttp(new Request(new URL(input, "https://research.example"), init), fixture.configured_env,
          {} as ExecutionContext, { accessVerifier: verifier() });
      }
      return fixture.providerFetch(input, init);
    });
    const introspector = await introspectWorkflow(runtime.RESEARCH_WORKFLOW);
    try {
      expect(await db.prepare("SELECT COUNT(*) AS n FROM research_workflow_run").first<number>("n")).toBe(0);
      const requestBody = JSON.stringify({ query: fixture.query, product: "RESEARCH",
        scope_expression: { kind: "PROJECT", project_id: fixture.project_id }, literals: [],
        evidence_grade: "E1", budget_ref: "research-budget-v1", max_results: 8 });
      const admitted = await startResearchRun(requestBody, "current-native-dispatch-v1", runtime.DEPLOYMENT_GENERATION);
      const instances = await introspector.get();
      expect(instances).toHaveLength(1);
      const instance = instances[0];
      if (instance === undefined) throw new Error("HTTP-created native Workflow missing");
      try { await instance.waitForStatus("complete"); }
      catch (error) {
        const failure = await db.prepare("SELECT first_failure_json,latest_failure_json FROM research_workflow_run WHERE operation_id=?1")
          .bind(admitted.workflow_instance_id).first();
        const models = await db.prepare("SELECT state,error_code,reason_codes_json FROM research_model_attempt").all();
        throw new Error(`Native current dispatch did not complete: ${JSON.stringify({ failure, models: models.results,
          model_calls: fixture.modelCalls() })}`, { cause: error });
      }
      const output = await instance.getOutput() as { state: string; operation_id: string; receipt_refs: string[] };
      expect(output.state).toBe("ENGINE_COMPLETED");
      expect(output.operation_id).toBe(admitted.workflow_instance_id);
      expect(output.receipt_refs).toHaveLength(18);
      expect(JSON.stringify(output)).not.toContain("completion_disposition");
      const run = await db.prepare("SELECT handler_generation,first_failure_json,latest_failure_json FROM research_workflow_run WHERE operation_id=?1")
        .bind(admitted.workflow_instance_id).first();
      expect(run).toEqual({ handler_generation: SERVER_OWNED_SEMANTIC_HANDLER_GENERATION,
        first_failure_json: null, latest_failure_json: null });
      const state = await durableState(admitted.workflow_instance_id);
      expect(state.checkpoints.map((row) => row.stage_index)).toEqual(RESEARCH_WORKFLOW_STAGES.map((_, index) => index));
      expect(state.attempts).toEqual(RESEARCH_WORKFLOW_STAGES.map((_, stage_index) => ({ stage_index, state: "COMMITTED" })));
      expect(state.outbox).toBe(18); expect(state.ledger).toBe(18);
      expect(state.models).toHaveLength(2);
      for (const model of state.models) {
        expect(model.state).toBe("SUCCEEDED"); expect(model.receipt_sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(model.readback_sha256).toBe(model.output_sha256);
      }
      for (const row of state.checkpoints) {
        expect(new TextEncoder().encode(row.receipt_json).byteLength).toBeLessThanOrEqual(65_536);
        expect(row.receipt_json).not.toContain("completion_disposition");
      }
      expect(fixture.modelCalls()).toBe(2);
      const status = await readResearchRunStatus(admitted.workflow_instance_id, runtime.DEPLOYMENT_GENERATION);
      expect(status.execution_state).toBe("ENGINE_COMPLETED");
      // Terminal GET uses canonical state and omits the optional engine observation.
      expect(status.engine_status).toBe("unknown");
      expect(status.next_stage_index).toBe(18); expect(status.answer.availability).toBe("draft");
      if (status.answer.availability !== "draft") throw new Error("Current Workflow report draft missing");
      const ref = status.answer.artifact_ref;
      const artifact = await readResearchArtifact(ref, runtime.DEPLOYMENT_GENERATION);
      expect(artifact.artifact_ref).toEqual(ref); expect(artifact.status).toBe("DRAFT");
      const section = artifact.sections[0];
      if (section === undefined) throw new Error("Current report section missing");
      const saved = await readResearchArtifactSection(ref, section);
      expect(saved.bytes.byteLength).toBeGreaterThan(0);
      const citations = await readResearchArtifactSectionCitations(ref, section.section_ref,
        runtime.DEPLOYMENT_GENERATION, undefined, section.verification_receipt_ref);
      expect(citations.semantic_verification).toBe("EXECUTED");
      if (citations.semantic_verification !== "EXECUTED") throw new Error("Current independent claim audit missing");
      expect(citations.audit.claims).toHaveLength(1);
      expect(citations.audit.claims[0]?.disposition).toBe("SUPPORTED");
      expect(citations.cited_evidence).toHaveLength(1);
      expect(Object.values(section.statement_labels)).toEqual(["SOURCE_SUPPORTED"]);
      const history = await readResearchRunHistory(runtime.DEPLOYMENT_GENERATION);
      expect(history.runs.map((entry) => entry.status.workflow_instance_id)).toContain(admitted.workflow_instance_id);
      expect(await startResearchRun(requestBody, "current-native-dispatch-v1", runtime.DEPLOYMENT_GENERATION)).toEqual(admitted);
      expect(await introspector.get()).toHaveLength(1);
      expect(await readResearchArtifact(ref, runtime.DEPLOYMENT_GENERATION)).toEqual(artifact);
      expect(await readResearchArtifactSection(ref, section)).toEqual(saved);
      expect(await durableState(admitted.workflow_instance_id)).toEqual(state);
      expect(fixture.modelCalls()).toBe(2);
      const foreign = await handleHttp(new Request(`https://research.example/api/v1/research/run/${encodeURIComponent(admitted.workflow_instance_id)}`),
        runtime, {} as ExecutionContext, { accessVerifier: verifier("foreign-owner") });
      expect(foreign.status).toBe(404); await foreign.arrayBuffer();
      expect(fixture.modelCalls()).toBe(2);
    } finally {
      await introspector.dispose();
      vi.unstubAllGlobals();
    }
  }, 30_000);
});
