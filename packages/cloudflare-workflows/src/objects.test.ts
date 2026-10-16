import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkflowObject } from "./objects.js";
import { digest, type WorkflowObject } from "./types.js";

const sha = "a".repeat(64);
const expected: WorkflowObject = { object_ref: "workflow/private-key", sha256: sha, byte_length: 1,
  residency: { scope_domain_id: "scope", access_domain_id: "access", confidentiality_domain_id: "private",
    encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
    content_digest: { algorithm: "sha256", digest: sha } } };
const head = { key: expected.object_ref, size: 1, etag: "exact-etag",
  checksums: { sha256: new Uint8Array(32).fill(170).buffer } };
afterEach(() => vi.restoreAllMocks());

describe("exact workflow object read diagnostics", () => {
  it("retains a bounded subrequest diagnosis without leaking an exception or retrying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const readHead = vi.fn().mockRejectedValue(new Error("Too many subrequests; Bearer PRIVATE_SECRET"));
    const get = vi.fn();
    await expect(readWorkflowObject({ head: readHead, get } as unknown as R2Bucket, expected))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_UNAVAILABLE" });
    expect(readHead).toHaveBeenCalledOnce(); expect(get).not.toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("SUBREQUEST_LIMIT");
    expect(logged).not.toContain("PRIVATE_SECRET");
    expect(logged).not.toContain(expected.object_ref);
  });

  it("distinguishes absent immutable objects from failed conditional reads", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(readWorkflowObject({ head: async () => null } as unknown as R2Bucket, expected))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_UNAVAILABLE" });
    expect(JSON.stringify(warn.mock.calls)).toContain("OBJECT_MISSING");
    const get = vi.fn().mockRejectedValue(new Error("Network connection unavailable"));
    await expect(readWorkflowObject({ head: async () => head, get } as unknown as R2Bucket, expected))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_UNAVAILABLE" });
    expect(get).toHaveBeenCalledExactlyOnceWith(expected.object_ref, { onlyIf: { etagMatches: head.etag } });
    expect(JSON.stringify(warn.mock.calls)).toContain("UPSTREAM_UNAVAILABLE");
  });

  it("keeps byte and checksum verification and distinguishes corrupt metadata", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bytes = new Uint8Array([42]), contentSha = await digest(bytes);
    const valid = { ...expected, sha256: contentSha,
      residency: { ...expected.residency, content_digest: { algorithm: "sha256" as const, digest: contentSha } } };
    const metadata = { ...head, checksums: { sha256: Uint8Array.from(contentSha.match(/../gu) ?? [], hex => parseInt(hex, 16)).buffer } };
    const bucket = { head: async () => metadata,
      get: async () => ({ ...metadata, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) }) } as unknown as R2Bucket;
    await expect(readWorkflowObject(bucket, valid)).resolves.toEqual(bytes);
    await expect(readWorkflowObject(bucket, expected)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(warn).not.toHaveBeenCalled();
  });
});
