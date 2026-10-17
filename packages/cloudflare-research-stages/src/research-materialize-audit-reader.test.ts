/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as WorkflowsModule from "@eliotr/cloudflare-workflows";
import type * as EvidenceModule from "@eliotr/cloudflare-evidence";
import type { StageRequest } from "@eliotr/cloudflare-workflows";
import { readCommittedResearchMaterializeAudit } from "./research-materialize-audit-reader.js";

const mocks = vi.hoisted(() => ({
  fail: vi.fn((code: string): never => {
    const error = new Error(code) as Error & { code: string };
    error.code = code;
    throw error;
  }),
  readCommittedStageLineage: vi.fn(),
  readWorkflowObject: vi.fn(),
  evidenceSha256Bytes: vi.fn(async (bytes: Uint8Array) =>
    (bytes.byteLength === 17 ? "b".repeat(64) : "d".repeat(64))),
}));

vi.mock("@eliotr/cloudflare-evidence", async () => ({
  ...await vi.importActual<typeof EvidenceModule>("@eliotr/cloudflare-evidence"),
  evidenceSha256Bytes: mocks.evidenceSha256Bytes,
}));

vi.mock("@eliotr/cloudflare-workflows", async () => ({
  ...await vi.importActual<typeof WorkflowsModule>("@eliotr/cloudflare-workflows"),
  WorkflowCheckpointError: class WorkflowCheckpointError extends Error {},
  WorkflowCheckpointStore: class WorkflowCheckpointStore {
    constructor(..._args: unknown[]) {}
  },
  fail: mocks.fail,
  readCommittedStageLineage: mocks.readCommittedStageLineage,
  readWorkflowObject: mocks.readWorkflowObject,
}));

function lineageFor(stage: string, revision: number, inputRef = `${stage}-input`) {
  const outputRef = `${stage}-output`;
  return {
    request: {
      protocol: "eliotr.workflow-stage.v1",
      operation_id: "operation-1",
      investigation_ref: { id: "investigation-1", revision },
      stage,
      idempotency_key: `${stage}-key-1`,
      handler_generation: "research-handlers.exploratory.v9",
      input_manifest: {
        object_ref: inputRef,
        sha256: "a".repeat(64),
        byte_length: 3,
        residency: { scope_domain_id: "scope-1", access_domain_id: "owner-1" },
      },
    },
    receipt: {
      engine_state: "CHECKPOINTED",
      operation_id: "operation-1",
      stage,
      investigation_ref: { id: "investigation-1", revision: revision + 1 },
      input_manifest_ref: inputRef,
      output_manifest: {
        object_ref: outputRef,
        sha256: "b".repeat(64),
        byte_length: 3,
        residency: { scope_domain_id: "scope-1", access_domain_id: "owner-1" },
      },
      attempt_ref: `${stage}-attempt-1`,
      request_sha256: "c".repeat(64),
    },
    attempt_ref: `${stage}-attempt-1`,
    request_sha256: "c".repeat(64),
  };
}

function contiguousLineages() {
  const verify = lineageFor("VERIFY", 12);
  const audit = lineageFor("AUDIT_CLAIMS", 13, verify.receipt.output_manifest.object_ref);
  const citations = lineageFor("RESOLVE_CITATIONS", 14, audit.receipt.output_manifest.object_ref);
  const coverage = lineageFor("CALCULATE_COVERAGE", 15, citations.receipt.output_manifest.object_ref);
  return [verify, audit, citations, coverage] as const;
}

function readerInput(input: Uint8Array, _request: StageRequest) {
  return {
    database: {},
    work_bucket: {},
    request: {
      protocol: "eliotr.workflow-stage.v1",
      operation_id: "operation-1",
      investigation_ref: { id: "investigation-1", revision: 16 },
      stage: "MATERIALIZE",
      idempotency_key: "materialize-key-1",
      handler_generation: "research-handlers.exploratory.v9",
      input_manifest: {
        object_ref: "CALCULATE_COVERAGE-output",
        sha256: "b".repeat(64),
        byte_length: input.byteLength,
        residency: {},
      },
    },
    principal: {},
    context: {},
    input_bytes: input,
    synthesis_readback: {},
    normalized_synthesis: {},
  } as never;
}

describe("Research materialize audit ordered joins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.evidenceSha256Bytes.mockImplementation(async (bytes: Uint8Array) =>
      (bytes.byteLength === 17 ? "b".repeat(64) : "d".repeat(64)));
  });

  it("joins four lineage reads and preserves the first failure in caller order", async () => {
    const order: string[] = [];
    const gate = (stage: string, revision: number, delayMs: number) => async () => {
      order.push(`start:${stage}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(`end:${stage}`);
      return lineageFor(stage, revision);
    };
    mocks.readCommittedStageLineage
      .mockImplementationOnce(gate("VERIFY", 12, 30))
      .mockImplementationOnce(gate("AUDIT_CLAIMS", 13, 10))
      .mockImplementationOnce(gate("RESOLVE_CITATIONS", 14, 20))
      .mockImplementationOnce(gate("CALCULATE_COVERAGE", 15, 0));
    mocks.readWorkflowObject.mockRejectedValueOnce(Object.assign(new Error("output boom"), { code: "WORKFLOW_OUTPUT_CORRUPT" }));
    const input = new TextEncoder().encode("materialize-input");
    const request = { stage: "MATERIALIZE" } as StageRequest;
    await expect(readCommittedResearchMaterializeAudit(readerInput(input, request))).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(mocks.readCommittedStageLineage).toHaveBeenCalledTimes(4);
    expect(order.slice(0, 4)).toEqual(["start:VERIFY", "start:AUDIT_CLAIMS", "start:RESOLVE_CITATIONS", "start:CALCULATE_COVERAGE"]);
    expect(order).toContain("end:CALCULATE_COVERAGE");
  });

  it("fails closed when a lineage read is missing or corrupt before any output read", async () => {
    for (const variant of ["missing", "corrupt"] as const) {
      vi.clearAllMocks();
      mocks.evidenceSha256Bytes.mockImplementation(async (bytes: Uint8Array) =>
        (bytes.byteLength === 17 ? "b".repeat(64) : "d".repeat(64)));
      if (variant === "missing") {
        mocks.readCommittedStageLineage
          .mockResolvedValueOnce(lineageFor("VERIFY", 12))
          .mockRejectedValueOnce(Object.assign(new Error("missing lineage"), { code: "WORKFLOW_OUTPUT_CORRUPT" }))
          .mockResolvedValueOnce(lineageFor("RESOLVE_CITATIONS", 14))
          .mockResolvedValueOnce(lineageFor("CALCULATE_COVERAGE", 15));
      } else {
        const [verify, audit, citations, coverage] = contiguousLineages();
        const corrupt = { ...citations, receipt: { ...citations.receipt, engine_state: "BROKEN" } };
        mocks.readCommittedStageLineage
          .mockResolvedValueOnce(verify)
          .mockResolvedValueOnce(audit)
          .mockResolvedValueOnce(corrupt)
          .mockResolvedValueOnce(coverage);
      }
      const input = new TextEncoder().encode("materialize-input");
      const request = { stage: "MATERIALIZE" } as StageRequest;
      await expect(readCommittedResearchMaterializeAudit(readerInput(input, request))).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
      expect(mocks.readCommittedStageLineage).toHaveBeenCalledTimes(4);
      expect(mocks.readWorkflowObject).not.toHaveBeenCalled();
    }
  });
});
