import { expect, it, vi } from "vitest";
import type { RawFileCaptureRequest } from "@eliotr/interfaces";
import type { NativeWebSearchRawCaptureOwnerPort } from "@eliotr/platform-cloudflare";
import { createRawCaptureWorkflowOwnerService, type RawCaptureOwnerEnvironment } from "./raw-capture-owner-service.js";

it("denies a durable service actor before raw capture reaches D1 or R2", async () => {
  const prepare = vi.fn(() => { throw new Error("D1 must not be reached"); });
  const bucketPut = vi.fn(() => { throw new Error("R2 must not be reached"); });
  const readCurrentAuthority = vi.fn(async () => ({
    principal_ref: "principal-1",
    client_class: "trusted_agent" as const,
    credential_generation: "credential-1",
    workflow_state: "ACTIVE" as const,
  }));
  const env = {
    CORE_DB: { prepare },
    EVIDENCE_BUCKET: { put: bucketPut },
  } as unknown as RawCaptureOwnerEnvironment;
  const service = createRawCaptureWorkflowOwnerService(env, {
    operation_id: "research-operation-1",
    principal: {
      principal_ref: "principal-1",
      credential_generation: "credential-1",
      deployment_generation: "deployment-1",
    },
    read_current_authority: readCurrentAuthority,
  }) satisfies NativeWebSearchRawCaptureOwnerPort;
  const request: RawFileCaptureRequest = {
    idempotency_key: "capture-key-1",
    original_file_name: "candidate.md",
    content_sha256: "a".repeat(64),
    size_bytes: 1,
    content_type: "text/markdown; charset=utf-8",
    body: new ReadableStream<Uint8Array>(),
  };

  await expect(service.captureRawFile(request)).rejects.toMatchObject({
    code: "RAW_CAPTURE_OWNER_NOT_CURRENT",
  });
  expect(readCurrentAuthority).toHaveBeenCalledTimes(1);
  expect(prepare).not.toHaveBeenCalled();
  expect(bucketPut).not.toHaveBeenCalled();
});
