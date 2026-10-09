import { expect, it, vi } from "vitest";
import type { RawCaptureReceipt } from "./raw-ingest-types.js";
import {
  bindRawCaptureWorkflowOwnerOperations,
  bindRawCaptureWorkflowServerReadOperations,
  type RawCaptureWorkflowOwnerOperations,
  type RawCaptureWorkflowServerReadAuthorityInput,
  type RawCaptureWorkflowServerReadAuthoritySnapshot,
  type RawCaptureWorkflowPrincipal,
} from "./raw-capture-workflow-owner-service.js";

const capture: RawCaptureReceipt = {
  protocol: "eliotr.raw-file-capture.v1",
  capture_id: "raw-capture-1",
  principal_ref: "principal-1",
  owner_system_id: "owner-1",
  source_namespace_id: "namespace-1",
  source_revision_ref: "raw-revision-1",
  source_logical_id: "raw-source-1",
  source_owner_generation: "owner-generation-1",
  idempotency_key: "capture-key-1",
  original_file_name: "candidate.md",
  object_key: "evidence/raw-capture-1",
  residency_key_digest: "a".repeat(64),
  content_sha256: "b".repeat(64),
  size_bytes: 1,
  content_type: "text/markdown",
  etag: "etag-1",
  captured_at: "2026-10-09T12:00:00.000Z",
};

it("withholds full server readback when deployment authority changes after the read", async () => {
  const operationId = "research-operation-1";
  const principal: RawCaptureWorkflowPrincipal = {
    principal_ref: "principal-1",
    credential_generation: "credential-1",
    deployment_generation: "deployment-1",
  };
  let authorityRead = 0;
  const readCurrentAuthority: RawCaptureWorkflowServerReadAuthorityInput["read_current_authority"] = vi.fn(
    async (
      currentOperationId: string,
      currentPrincipal: Omit<RawCaptureWorkflowPrincipal, "signal">,
    ): Promise<RawCaptureWorkflowServerReadAuthoritySnapshot> => {
      expect(currentOperationId).toBe(operationId);
      expect(currentPrincipal).toEqual({
        principal_ref: principal.principal_ref,
        credential_generation: principal.credential_generation,
        deployment_generation: principal.deployment_generation,
      });
      authorityRead += 1;
      return {
        principal_ref: principal.principal_ref,
        client_class: "owner_pwa",
        credential_generation: principal.credential_generation,
        deployment_generation: authorityRead === 1 ? "deployment-1" : "deployment-2",
        workflow_state: "ACTIVE",
      };
    },
  );
  const authority: RawCaptureWorkflowServerReadAuthorityInput = {
    operation_id: operationId,
    principal,
    read_current_authority: readCurrentAuthority,
  };
  const publicOperations: RawCaptureWorkflowOwnerOperations = {
    async captureRawFile() {
      throw new Error("capture is not part of this readback test");
    },
    async readRawFileByIdempotency() {
      return null;
    },
  };
  const serverOperations = {
    ...publicOperations,
    readRawCaptureForServer: vi.fn(async () => capture),
  };

  const publicPort = bindRawCaptureWorkflowOwnerOperations(authority, () => publicOperations);
  expect(publicPort).not.toHaveProperty("readRawCaptureForServer");

  const serverPort = bindRawCaptureWorkflowServerReadOperations(authority, () => serverOperations);
  await expect(serverPort.readRawCaptureForServer(capture.capture_id)).rejects.toMatchObject({
    code: "RAW_CAPTURE_OWNER_NOT_CURRENT",
  });
  expect(serverOperations.readRawCaptureForServer).toHaveBeenCalledOnce();
  expect(readCurrentAuthority).toHaveBeenCalledTimes(2);
});
