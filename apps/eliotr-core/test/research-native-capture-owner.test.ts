import { beforeEach, expect, it, vi } from "vitest";
import type {
  RawCaptureWorkflowOwnerAuthorityInput,
  RawCaptureWorkflowOwnerPort,
} from "@eliotr/cloudflare-raw-ingest";
import type { RawFileCaptureRequest, RawFileCaptureResult } from "@eliotr/interfaces";
import type { RunStatusReadInput, WorkflowPrincipal, WorkflowRunStatus } from "@eliotr/cloudflare-workflows";
import { bindRawCaptureWorkflowOwnerOperations } from "../../../packages/cloudflare-raw-ingest/src/raw-capture-workflow-owner-service.js";
import type { Env } from "../src/env.js";
import { createResearchNativeCaptureOwner } from "../src/research-native-capture-owner.js";

const readers = vi.hoisted(() => ({
  createOwner: vi.fn(),
  loadAccess: vi.fn(),
  loadHeldScope: vi.fn(),
  readRunStatus: vi.fn(),
  requireDeploymentCompatibility: vi.fn(),
  authorityInput: undefined as unknown,
  workflowState: "ACTIVE" as "ACTIVE" | "CANCELLED",
  statusCredentialGeneration: "credential-1",
}));

vi.mock("@eliotr/cloudflare-raw-ingest", () => ({
  createRawCaptureWorkflowOwnerService: readers.createOwner,
}));
vi.mock("@eliotr/cloudflare-workflows", () => ({
  WorkflowCheckpointError: class extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = "WorkflowCheckpointError";
    }
  },
  readResearchRunStatus: readers.readRunStatus,
}));
vi.mock("@eliotr/cloudflare-research-runtime/research-retrieval-composition.js", () => ({
  loadHeldResearchScope: readers.loadHeldScope,
}));
vi.mock("../src/research-client-execution.js", () => ({
  loadResearchExecutionAccess: readers.loadAccess,
}));
vi.mock("../src/research-deployment-compatibility.js", () => ({
  requireResearchDeploymentCompatibility: readers.requireDeploymentCompatibility,
}));

const operationId = "research-operation-1";
const principal: WorkflowPrincipal = {
  principal_ref: "principal-1",
  credential_generation: "credential-1",
  deployment_generation: "deployment-1",
};
const env = {
  CORE_DB: {} as D1Database,
  SEARCH_DB: {} as D1Database,
  EVIDENCE_BUCKET: {} as R2Bucket,
  DEPLOYMENT_GENERATION: "deployment-1",
} as Env;
const currentAccess = {
  principal_ref: principal.principal_ref,
  client_class: "owner_pwa" as const,
  credential_generation: principal.credential_generation,
};
const heldScope = {
  operation_id: operationId,
  investigation_id: "investigation-1",
  scope_snapshot_ref: { id: "scope-1", revision: 3 },
  deployment_generation: principal.deployment_generation,
};
const rawCaptureResult: RawFileCaptureResult = {
  protocol: "eliotr.raw-file-capture.v1",
  disposition: "CAPTURED",
  capture_id: "capture-1",
  idempotency_key: "capture-key-1",
  original_file_name: "candidate.md",
  content_sha256: "a".repeat(64),
  size_bytes: 1,
  content_type: "text/markdown; charset=utf-8",
  captured_at: "2026-10-09T00:00:00.000Z",
};
const rawCaptureRequest: RawFileCaptureRequest = {
  idempotency_key: rawCaptureResult.idempotency_key,
  original_file_name: rawCaptureResult.original_file_name,
  content_sha256: rawCaptureResult.content_sha256,
  size_bytes: rawCaptureResult.size_bytes,
  content_type: rawCaptureResult.content_type,
  body: new ReadableStream<Uint8Array>(),
};
const rawOwnerPort = {
  captureRawFile: vi.fn(async (_request: RawFileCaptureRequest) => rawCaptureResult),
  readRawFileByIdempotency: vi.fn(async (_key: string) => null),
} satisfies RawCaptureWorkflowOwnerPort;

function status(state: "ACTIVE" | "CANCELLED", scope: Awaited<ReturnType<typeof readers.loadHeldScope>>) {
  return {
    operation_id: operationId,
    investigation_id: scope.investigation_id,
    principal_ref: principal.principal_ref,
    credential_generation: readers.statusCredentialGeneration,
    deployment_generation: principal.deployment_generation,
    scope_snapshot_id: scope.scope_snapshot_ref.id,
    scope_snapshot_revision: scope.scope_snapshot_ref.revision,
    state,
  } as WorkflowRunStatus;
}

beforeEach(() => {
  vi.clearAllMocks();
  readers.authorityInput = undefined;
  readers.workflowState = "ACTIVE";
  readers.statusCredentialGeneration = principal.credential_generation;
  rawOwnerPort.captureRawFile.mockReset().mockResolvedValue(rawCaptureResult);
  rawOwnerPort.readRawFileByIdempotency.mockReset().mockResolvedValue(null);
  readers.createOwner.mockImplementation((_env: unknown, authority: unknown) => {
    readers.authorityInput = authority;
    return bindRawCaptureWorkflowOwnerOperations(
      authority as RawCaptureWorkflowOwnerAuthorityInput,
      () => rawOwnerPort,
    );
  });
  readers.loadAccess.mockResolvedValue(currentAccess);
  readers.loadHeldScope.mockResolvedValue(heldScope);
  readers.requireDeploymentCompatibility.mockResolvedValue({
    origin_deployment_generation: principal.deployment_generation,
    active_deployment_generation: principal.deployment_generation,
    backend_fingerprint: null,
  });
  readers.readRunStatus.mockImplementation(async (input: unknown) => {
    const read = input as RunStatusReadInput;
    const before = await read.recheck_authority();
    const after = await read.recheck_authority();
    expect(after).toEqual(before);
    return status(readers.workflowState, heldScope);
  });
});

function authorityInput(): RawCaptureWorkflowOwnerAuthorityInput {
  const input = readers.authorityInput as RawCaptureWorkflowOwnerAuthorityInput | undefined;
  if (input === undefined) throw new Error("raw capture authority was not composed");
  return input;
}

it("rechecks deployment, durable owner, and held scope around the raw effect", async () => {
  const owner = createResearchNativeCaptureOwner(env, operationId, principal);
  const authority = authorityInput();
  expect(authority.operation_id).toBe(operationId);
  expect(authority.principal).toMatchObject(principal);

  await expect(owner.captureRawFile(rawCaptureRequest)).resolves.toEqual(rawCaptureResult);

  expect(readers.requireDeploymentCompatibility).toHaveBeenCalledTimes(4);
  expect(readers.loadAccess).toHaveBeenCalledTimes(4);
  expect(readers.loadHeldScope).toHaveBeenCalledTimes(4);
  expect(readers.readRunStatus).toHaveBeenCalledTimes(2);
});

it("rejects a current service actor before loading held owner scope", async () => {
  readers.loadAccess.mockResolvedValue({ ...currentAccess, client_class: "trusted_agent" });
  const owner = createResearchNativeCaptureOwner(env, operationId, principal);

  await expect(owner.captureRawFile(rawCaptureRequest))
    .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  expect(readers.loadHeldScope).not.toHaveBeenCalled();
  expect(rawOwnerPort.captureRawFile).not.toHaveBeenCalled();
});

it("does not return a raw result when Workflow activity or credential generation changes after the effect", async () => {
  const owner = createResearchNativeCaptureOwner(env, operationId, principal);
  rawOwnerPort.captureRawFile.mockImplementationOnce(async () => {
    readers.workflowState = "CANCELLED";
    return rawCaptureResult;
  });

  await expect(owner.captureRawFile(rawCaptureRequest))
    .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  expect(rawOwnerPort.captureRawFile).toHaveBeenCalledTimes(1);

  readers.workflowState = "ACTIVE";
  rawOwnerPort.captureRawFile.mockImplementationOnce(async () => {
    readers.statusCredentialGeneration = "credential-2";
    return rawCaptureResult;
  });
  await expect(owner.captureRawFile(rawCaptureRequest))
    .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  expect(rawOwnerPort.captureRawFile).toHaveBeenCalledTimes(2);
  expect(readers.readRunStatus).toHaveBeenCalledWith(expect.objectContaining({
    operation_id: operationId,
    principal,
  }));
});
