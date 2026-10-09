
import { describe, expect, it } from "vitest";
import { createBundleWireApi, type ImportIdentity } from "./bundle-wire.js";
import type { LegacyErrorDetails, LegacyErrorFactory } from "../../legacy/http.js";
import type { EpochPort } from "../../transport/client.js";
import type { RawBinaryTransport } from "./raw.js";

/** Targeted boundaries for the moved ingest wire decoders and its binary seam. */

const errors: LegacyErrorFactory = (details: LegacyErrorDetails) =>
  Object.assign(new Error(details.message), details);

const DIGEST = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BACKUP = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const clock = { now: () => NOW };
const identity: ImportIdentity = {
  operation: "operation-1",
  manifestDigest: DIGEST,
  sourceRevision: "revision-1",
  generation: "deployment-1",
};

const envelope = (data: unknown) => ({
  data,
  trace_id: "trace-1",
  deployment_generation: "deployment-1",
});

/** A receipt satisfying `BundleAdmissionReceiptSchema`; never a partial cast. */
const receipt = (overrides: Record<string, unknown> = {}) => ({
  operation_id: "operation-1",
  manifest_sha256: DIGEST,
  source_revision_ref: "revision-1",
  normalized_artifact_ref: "artifact-1",
  object_residency_key_digest: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  decision: "ADMITTED",
  reason_codes: [],
  readback_sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  committed_at: "2026-10-09T12:00:00.000Z",
  ...overrides,
});

const statusRow = (overrides: Record<string, unknown> = {}) => ({
  operation_id: "operation-1",
  source_revision_ref: "revision-1",
  state: "COMMITTED",
  expires_at: "2026-10-09T13:00:00.000Z",
  updated_at: "2026-10-09T12:00:00.000Z",
  receipt: receipt(),
  ...overrides,
});

const preparedRow = (overrides: Record<string, unknown> = {}) => ({
  operation_id: "operation-1",
  manifest_sha256: DIGEST,
  disposition: "UPLOAD_REQUIRED",
  expires_at: "2026-10-09T13:00:00.000Z",
  reason_codes: [],
  files: [{ path: "content.md", expected_sha256: DIGEST, max_part_bytes: 6291456 }],
  multipart_session_ref: "session-1",
  ...overrides,
});

/** The binary port is a real `requestBinaryJson`; a JSON-only probe must never call it. */
const binarySeam = (behaviour: (path: string, input: unknown) => Promise<unknown>) =>
  ({ requestBinaryJson: behaviour });

const binaryThatThrows = binarySeam(async () => {
  throw new Error("binary seam must not be called by a JSON-only probe");
});

const liveEpoch = (): { epoch: EpochPort; advance(): void } => {
  let stamp: object | undefined = {};
  return {
    epoch: {
      capture: () => stamp,
      isCurrent: (capture: unknown) => stamp !== undefined && capture === stamp,
    },
    advance: () => { stamp = {}; },
  };
};

const wire = (over: {
  readonly binary?: RawBinaryTransport;
  readonly epoch?: EpochPort;
} = {}) => createBundleWireApi(
  { requestApi: async () => { throw new Error("unused JSON transport"); } },
  over.binary ?? binaryThatThrows,
  errors,
  over.epoch ?? liveEpoch().epoch,
  clock,
);
describe("ingest wire decoders", () => {
  it("decodes a committed status and its receipt as one identity", () => {
    const result = wire().decodeImportStatus(statusRow(), identity);
    expect(result.state).toBe("COMMITTED");
    expect(result.receipt?.operation_id).toBe("operation-1");
  });

  it("rejects a status whose state contradicts its receipt decision", () => {
    expect(() => wire().decodeImportStatus(statusRow({ state: "VERIFIED" }), identity))
      .toThrow(expect.objectContaining({ code: "INGEST_RESPONSE_MISMATCH", status: 502 }));
    expect(() => wire().decodeImportStatus(
      statusRow({ receipt: receipt({ decision: "QUARANTINED" }) }), identity))
      .toThrow(expect.objectContaining({ code: "INGEST_RESPONSE_MISMATCH", status: 502 }));
  });

  it("rejects a committed status with no receipt instead of inferring admission", () => {
    expect(() => wire().decodeImportStatus(statusRow({ receipt: undefined }), identity))
      .toThrow(expect.objectContaining({ code: "INGEST_RESPONSE_MISMATCH" }));
  });

  it("binds a receipt to its operation, digest and revision", () => {
    expect(() => wire().receiptFor(receipt({ operation_id: "other" }), identity))
      .toThrow(expect.objectContaining({ code: "INGEST_RESPONSE_MISMATCH" }));
    expect(() => wire().receiptFor(receipt({ manifest_sha256: BACKUP }), identity))
      .toThrow(expect.objectContaining({ code: "INGEST_RESPONSE_MISMATCH" }));
    expect(() => wire().receiptFor(receipt({ source_revision_ref: "revision-2" }), identity))
      .toThrow(expect.objectContaining({ code: "INGEST_RESPONSE_MISMATCH" }));
  });

  it("requires a session match before continuing a held upload", () => {
    const row = statusRow({ staging_session_ref: "session-2" });
    expect(() => wire().decodeImportStatus(row, identity, "session-1"))
      .toThrow(expect.objectContaining({ code: "INGEST_RESPONSE_MISMATCH" }));
  });
});

describe("ingest prepared decode", () => {
  it("keeps an admitted duplicate with its own receipt and no upload slots", () => {
    const existing = receipt({ decision: "DUPLICATE" });
    const result = wire().decodePrepared(preparedRow({
      disposition: "DUPLICATE", files: undefined, multipart_session_ref: undefined,
      existing_receipt: existing,
    }), null, "revision-1", 1, { "content.md": DIGEST }, "deployment-1");
    expect(result.rejected).toBe(false);
    expect(result.files).toHaveLength(0);
    expect(result.existing?.decision).toBe("DUPLICATE");
  });

  it("rejects a duplicate whose receipt decision contradicts the disposition", () => {
    expect(() => wire().decodePrepared(preparedRow({
      disposition: "DUPLICATE", files: undefined, multipart_session_ref: undefined,
      existing_receipt: receipt({ decision: "REJECTED" }),
    }), null, "revision-1", 1, {}, "deployment-1"))
      .toThrow(expect.objectContaining({ code: "INGEST_RESPONSE_MISMATCH" }));
  });

  it("rejects an upload slot whose digest or part bound is invalid", () => {
    expect(() => wire().decodePrepared(preparedRow({
      files: [{ path: "content.md", expected_sha256: BACKUP, max_part_bytes: 6291456 }],
    }), null, "revision-1", 1, { "content.md": DIGEST }, "deployment-1"))
      .toThrow(expect.objectContaining({ code: "INGEST_RESPONSE_MISMATCH" }));
    expect(() => wire().decodePrepared(preparedRow({
      files: [{ path: "content.md", expected_sha256: DIGEST, max_part_bytes: 1024 }],
    }), null, "revision-1", 1, { "content.md": DIGEST }, "deployment-1"))
      .toThrow(expect.objectContaining({ code: "INGEST_RESPONSE_MISMATCH" }));
  });

  it("rejects a reservation already expired against the injected clock", () => {
    expect(() => wire().decodePrepared(preparedRow({
      expires_at: "2026-10-09T11:00:00.000Z",
    }), null, "revision-1", 1, { "content.md": DIGEST }, "deployment-1"))
      .toThrow(expect.objectContaining({ code: "INGEST_RESPONSE_MISMATCH" }));
  });
});

describe("ingest wire binary seam", () => {
  it("sends the exact part bytes, bound and media type through the binary port only", async () => {
    const seen: { path: string; input: unknown }[] = [];
    const local = wire({
      binary: binarySeam(async (path, input) => {
        seen.push({ path, input });
        return envelope({
          operation_id: "operation-1", multipart_session_ref: "session-1",
          path: "content.md", part_number: 1, size_bytes: 3, etag: "etag-1",
        });
      }),
    });
    const result = await local.importBytesCall(
      "/api/v1/ingest/bundles/op/parts/1?path=content.md",
      { method: "PUT", bytes: new Uint8Array([1, 2, 3]), maximumBytes: 6291456,
        contentType: "application/octet-stream" }, "deployment-1");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/api/v1/ingest/bundles/op/parts/1?path=content.md");
    expect(seen[0]?.input).toMatchObject({
      method: "PUT", maximumBytes: 6291456,
      contentType: "application/octet-stream",
    });
    expect((seen[0]?.input as { bytes: Uint8Array }).bytes)
      .toEqual(new Uint8Array([1, 2, 3]));
    expect(result.generation).toBe("deployment-1");
  });

  it("refuses to return a binary response for a closed epoch", async () => {
    const { epoch, advance } = liveEpoch();
    let release: (value: unknown) => void = () => undefined;
    const gate = new Promise<unknown>((resolve) => { release = resolve; });
    const local = wire({
      binary: binarySeam(async () => {
        await gate;
        return envelope({ operation_id: "operation-1" });
      }),
      epoch,
    });
    const pending = local.importBytesCall(
      "/api/v1/ingest/bundles/op/parts/1",
      { method: "PUT", bytes: new Uint8Array([1]), maximumBytes: 16,
        contentType: "application/octet-stream" });
    advance();
    release(undefined);
    await expect(pending).rejects.toMatchObject({
      code: "API_SESSION_CLOSED", status: 503,
    });
  });
});
