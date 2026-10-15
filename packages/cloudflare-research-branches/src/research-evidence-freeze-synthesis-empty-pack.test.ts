import { describe, expect, it, vi } from "vitest";
import {
  createEvidenceFreezeSynthesisHandler,
  type EvidenceFreezeSynthesisContext,
  type EvidenceFreezeSynthesisModelDependencies,
} from "./research-evidence-freeze-composition.js";
import { WorkflowCheckpointError, type StageRequest, type WorkflowPrincipal } from "@eliotr/cloudflare-workflows";

const principal: WorkflowPrincipal = {
  principal_ref: "owner-1",
  credential_generation: "credential-1",
  deployment_generation: "deployment-1",
};

describe("empty synthesis evidence preflight", () => {
  it("fails with a known no-dispatch outcome before model preparation", async () => {
    const queryTexts: string[] = [];
    const first = vi.fn(async () => null);
    const database = {
      prepare(query: string) {
        queryTexts.push(query);
        return { bind: () => ({ first }) };
      },
      batch: vi.fn(),
    } as unknown as D1Database;
    const evidencePack = {
      pack_ref: { id: "pack-empty", revision: 1 },
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      resolved_evidence: [],
      omitted_candidates: [],
      trace_ref: { id: "trace-empty", revision: 1 },
      total_utf8_bytes: 0,
    };
    const frozen = {
      stage_five: { evidence_pack: evidencePack },
    } as unknown as EvidenceFreezeSynthesisContext;
    const readContext = vi.fn(async () => frozen);
    const prepareModel = vi.fn(async () => {
      throw new Error("model preparation must not run for an empty evidence pack");
    });
    const model = {
      database,
      work_bucket: {} as R2Bucket,
      operation_kind: "REPORT",
      gateway: {},
      prompt: {
        manifest_service: {},
        build_manifest_input: vi.fn(),
        resolve_trusted_parameters: vi.fn(),
        request_timeout_ms: 1_000,
      },
      pricing: {},
      prepare: prepareModel,
      spend_authorization: {},
      deployment_environment: "TEST",
    } as unknown as EvidenceFreezeSynthesisModelDependencies;
    const handler = createEvidenceFreezeSynthesisHandler({
      context: { read: readContext },
      model,
    });
    const inputBytes = new TextEncoder().encode("frozen synthesis input");
    const request = {
      protocol: "eliotr.workflow-stage.v1",
      operation_id: "operation-1",
      investigation_ref: { id: "investigation-1", revision: 13 },
      stage: "SYNTHESIZE",
      idempotency_key: "workflow-key-1",
      handler_generation: "research-handler-v1",
      input_manifest: {
        object_ref: "workflow/synthesis-input",
        sha256: "a".repeat(64),
        byte_length: inputBytes.byteLength,
        residency: { scope_domain_id: "scope-1", access_domain_id: principal.principal_ref },
      },
    } as unknown as StageRequest;

    const error = await handler.handler({
      request,
      principal,
      input_bytes: inputBytes,
      attempt_ref: "stage-attempt-1",
      budget_receipt_ref: "budget-1",
    }).then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorkflowCheckpointError);
    expect(error).toMatchObject({
      code: "WORKFLOW_INPUT_INVALID",
      failure: {
        protocol: "eliotr.workflow-failure-outcome.v1",
        code: "WORKFLOW_INPUT_INVALID",
        phase: "STAGE",
        stage: "SYNTHESIZE",
        retryable: false,
        dispatch_state: "NOT_STARTED",
        references_intact: "INTACT",
        recovery_action: "NONE",
      },
    });
    expect(readContext).toHaveBeenCalledOnce();
    expect(prepareModel).not.toHaveBeenCalled();
    expect(queryTexts).toHaveLength(1);
    expect(queryTexts[0]).toMatch(/^SELECT\b/iu);
    expect(database.batch).not.toHaveBeenCalled();
  });
});
