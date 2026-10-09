import { describe, expect, it, vi } from "vitest";
import { readRawMarkdownCandidate } from "./raw-markdown-candidate-reader.js";
import type { RawMarkdownCaptureReceipt } from "./raw-markdown-conversion-contract.js";

async function digestJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("readRawMarkdownCandidate expected conversion context", () => {
  it("rejects missing or nonstring generations before hashing conversion authority", async () => {
    const capture = {
      capture_id: "capture-1",
      source_owner_generation: "owner-generation-1",
      content_sha256: "a".repeat(64),
    } as RawMarkdownCaptureReceipt;
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => ({
        principal_ref: "principal-1",
        capture_id: capture.capture_id,
        content_sha256: capture.content_sha256,
        state: "COMPLETE",
        output_object_key: "raw-markdown/output.md",
      })),
    };
    const database = { prepare: vi.fn(() => statement) } as unknown as D1Database;
    const bucket = { get: vi.fn(async () => null) } as unknown as R2Bucket;
    const hash = vi.spyOn(crypto.subtle, "digest");
    try {
      for (const field of ["credential_generation", "deployment_generation", "profile_generation"] as const) {
        for (const value of [undefined, null, 123]) {
          const expected = {
            credential_generation: "credential-1",
            deployment_generation: "deployment-1",
            profile_generation: "profile-1",
            [field]: value,
          } as unknown as NonNullable<Parameters<typeof readRawMarkdownCandidate>[6]>;
          await expect(readRawMarkdownCandidate(database, bucket, { principal_ref: "principal-1" },
            capture, "operation-1", {}, expected)).resolves.toBeNull();
        }
      }
      expect(hash).not.toHaveBeenCalled();
      expect(bucket.get).not.toHaveBeenCalled();
    } finally {
      hash.mockRestore();
    }
  });

  it("rejects a profile-generation mismatch before opening normalized R2 bytes", async () => {
    const capture: RawMarkdownCaptureReceipt = {
      capture_id: "capture-1",
      principal_ref: "principal-1",
      owner_system_id: "owner-1",
      source_namespace_id: "namespace-1",
      source_revision_ref: "revision-1",
      source_logical_id: "logical-1",
      source_owner_generation: "owner-generation-1",
      original_file_name: "note.pdf",
      object_key: "raw/note.pdf",
      content_sha256: "a".repeat(64),
      size_bytes: 14,
      content_type: "application/pdf",
    };
    const operationId = "operation-1";
    const result = {
      protocol: "eliotr.raw-markdown-conversion.v1",
      state: "COMPLETE",
      operation_id: operationId,
      capture_id: capture.capture_id,
      content_sha256: capture.content_sha256,
      output_sha256: "b".repeat(64),
      output_bytes: 6,
      detected_mime: "text/markdown",
      format: "markdown",
      tokens: 1,
    };
    const actualAuthoritySha = await digestJson([
      "credential-1",
      "deployment-1",
      "profile-actual",
      capture.capture_id,
      capture.content_sha256,
      capture.source_owner_generation,
    ]);
    const row = {
      principal_ref: capture.principal_ref,
      capture_id: capture.capture_id,
      content_sha256: capture.content_sha256,
      state: "COMPLETE",
      output_object_key: "raw-markdown/operation-1/output.md",
      authority_sha256: actualAuthoritySha,
      result_json: JSON.stringify(result),
      result_sha256: await digestJson(result),
    };
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => row),
    };
    const database = { prepare: vi.fn(() => statement) } as unknown as D1Database;
    const bucket = { get: vi.fn(async () => null) } as unknown as R2Bucket;

    await expect(readRawMarkdownCandidate(
      database,
      bucket,
      { principal_ref: capture.principal_ref },
      capture,
      operationId,
      {},
      {
        credential_generation: "credential-1",
        deployment_generation: "deployment-1",
        profile_generation: "profile-expected",
      },
    )).resolves.toBeNull();
    expect(bucket.get).not.toHaveBeenCalled();
  });
});
