import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "./api.js";
import {
  captureRawFile,
  decodeRawFileCaptureEnvelope,
  prepareRawFileSelection,
  readRawFileByIdempotency,
  type RawUploadFile,
} from "./raw-file-api.js";

function file(name = "notes.txt", value = "hello"): RawUploadFile {
  const bytes = new TextEncoder().encode(value);
  return { name, size: bytes.byteLength, type: "text/plain", arrayBuffer: async () => bytes.slice().buffer };
}

afterEach(() => vi.unstubAllGlobals());

describe("raw file capture API", () => {
  it("uses a deterministic identity for reselected bytes and bounds the browser file", async () => {
    const first = await prepareRawFileSelection(file());
    const second = await prepareRawFileSelection(file());
    expect(second.content_sha256).toBe(first.content_sha256);
    expect(second.idempotency_key).toBe(first.idempotency_key);
    expect((await prepareRawFileSelection({ ...file(), type: "application/pdf" })).idempotency_key).not.toBe(first.idempotency_key);
    await expect(prepareRawFileSelection({ ...file(), size: 16 * 1024 * 1024 + 1 })).rejects.toMatchObject({ code: "RAW_FILE_INPUT_INVALID" });
    await expect(prepareRawFileSelection({ ...file(), name: "../notes.txt" })).rejects.toMatchObject({ code: "RAW_FILE_INPUT_INVALID" });
  });

  it("accepts only an exact CAPTURED receipt for the selected file", async () => {
    const selected = await prepareRawFileSelection(file());
    const receipt = {
      protocol: "eliotr.raw-file-capture.v1", disposition: "CAPTURED", capture_id: `raw-capture-${"a".repeat(48)}`,
      idempotency_key: selected.idempotency_key, original_file_name: selected.original_file_name,
      content_sha256: selected.content_sha256, size_bytes: selected.size_bytes, content_type: selected.content_type,
      captured_at: "2026-09-09T00:00:00.000Z",
    };
    const envelope = { data: receipt, trace_id: "trace-1", deployment_generation: "generation-1" };
    expect(decodeRawFileCaptureEnvelope(envelope, "generation-1", selected)).toMatchObject(receipt);
    expect(() => decodeRawFileCaptureEnvelope({ ...envelope, data: { ...receipt, content_sha256: "b".repeat(64) } }, "generation-1", selected))
      .toThrowError("Raw capture receipt does not match the selected file");
    expect(() => decodeRawFileCaptureEnvelope(envelope, "generation-2", selected)).toThrowError(ApiRequestError);
  });

  it("posts the Blob once without a forbidden Content-Length and validates the envelope", async () => {
    const selected = await prepareRawFileSelection(file());
    const response = { protocol: "eliotr.raw-file-capture.v1", disposition: "CAPTURED", capture_id: `raw-capture-${"c".repeat(48)}`,
      idempotency_key: selected.idempotency_key, original_file_name: selected.original_file_name,
      content_sha256: selected.content_sha256, size_bytes: selected.size_bytes, content_type: selected.content_type,
      captured_at: "2026-09-09T00:00:00.000Z" };
    const fetchMock = vi.fn(async (_path: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      expect(init.headers).not.toHaveProperty("Content-Length");
      expect((init.headers as Record<string, string>)["x-eliotr-original-file-name"]).toBe(encodeURIComponent(selected.original_file_name));
      return new Response(JSON.stringify({ data: response, trace_id: "trace-1", deployment_generation: "generation-1" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(captureRawFile(selected, "generation-1")).resolves.toMatchObject(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the idempotency lookup for explicit recovery without creating a new request", async () => {
    const selected = await prepareRawFileSelection(file());
    const response = { protocol: "eliotr.raw-file-capture.v1", disposition: "CAPTURED", capture_id: `raw-capture-${"d".repeat(48)}`,
      idempotency_key: selected.idempotency_key, original_file_name: selected.original_file_name,
      content_sha256: selected.content_sha256, size_bytes: selected.size_bytes, content_type: selected.content_type,
      captured_at: "2026-09-09T00:00:00.000Z" };
    const fetchMock = vi.fn(async (_path: string, init: RequestInit) => {
      expect(init.method).toBe("GET");
      expect((init.headers as Record<string, string>)["idempotency-key"]).toBe(selected.idempotency_key);
      return new Response(JSON.stringify({ data: response, trace_id: "trace-2", deployment_generation: "generation-1" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(readRawFileByIdempotency(selected, "generation-1")).resolves.toMatchObject(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
