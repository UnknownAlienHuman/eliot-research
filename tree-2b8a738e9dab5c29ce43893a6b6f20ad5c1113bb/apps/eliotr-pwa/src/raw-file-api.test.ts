import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "./api.js";
import {
  captureRawFile,
  convertRawFileToMarkdown,
  admitRawFileToLibrary,
  decodeRawFileCaptureEnvelope,
  decodeRawMarkdownConversionEnvelope,
  decodeRawNormalizedAdmissionEnvelope,
  prepareRawFileSelection,
  readRawFileByIdempotency,
  RAW_MARKDOWN_MAX_OUTPUT_BYTES,
  RAW_MARKDOWN_MAX_TOKENS,
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

  it("serializes the fixed conversion profile and reuses its operation identity", async () => {
    const selected = await prepareRawFileSelection(file("note.pdf", "pdf bytes"));
    const capture = {
      protocol: "eliotr.raw-file-capture.v1", disposition: "CAPTURED", capture_id: `raw-capture-${"e".repeat(48)}`,
      idempotency_key: selected.idempotency_key, original_file_name: selected.original_file_name,
      content_sha256: selected.content_sha256, size_bytes: selected.size_bytes, content_type: selected.content_type,
      captured_at: "2026-09-09T00:00:00.000Z",
    } as const;
    const operation = "a".repeat(64);
    const response = { protocol: "eliotr.raw-markdown-conversion.v1", state: "COMPLETE", operation_id: operation,
      capture_id: capture.capture_id, content_sha256: capture.content_sha256, output_sha256: "b".repeat(64),
      output_bytes: 12, detected_mime: "application/pdf", format: "markdown", tokens: 4 };
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (path: string, init: RequestInit) => {
      expect(path).toBe(`/api/v1/ingest/raw/${encodeURIComponent(capture.capture_id)}/markdown`);
      expect(init.method).toBe("POST");
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: response, trace_id: "trace-convert", deployment_generation: "generation-1" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(convertRawFileToMarkdown(capture, "generation-1")).resolves.toMatchObject(response);
    await expect(convertRawFileToMarkdown(capture, "generation-1")).resolves.toMatchObject(response);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toEqual({ idempotency_key: expect.stringMatching(/^raw-markdown-[a-f0-9]{64}$/u),
      max_output_bytes: RAW_MARKDOWN_MAX_OUTPUT_BYTES, max_tokens: RAW_MARKDOWN_MAX_TOKENS, timeout_ms: 300_000,
      conversion_options: { output: { format: "markdown" } } });
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("fails closed on conversion generation, identity, bounds and state-field drift", async () => {
    const selected = await prepareRawFileSelection(file());
    const capture = {
      protocol: "eliotr.raw-file-capture.v1", disposition: "CAPTURED", capture_id: `raw-capture-${"f".repeat(48)}`,
      idempotency_key: selected.idempotency_key, original_file_name: selected.original_file_name,
      content_sha256: selected.content_sha256, size_bytes: selected.size_bytes, content_type: selected.content_type,
      captured_at: "2026-09-09T00:00:00.000Z",
    } as const;
    const base = { protocol: "eliotr.raw-markdown-conversion.v1", operation_id: "c".repeat(64),
      capture_id: capture.capture_id, content_sha256: capture.content_sha256 };
    const complete = { ...base, state: "COMPLETE", output_sha256: "d".repeat(64), output_bytes: 1,
      detected_mime: "text/plain", format: "text", tokens: 1 };
    const envelope = (data: unknown, generation = "generation-1") => ({ data, trace_id: "trace-convert", deployment_generation: generation });
    expect(decodeRawMarkdownConversionEnvelope(envelope(complete), "generation-1", capture)).toMatchObject(complete);
    expect(() => decodeRawMarkdownConversionEnvelope(envelope({ ...complete, failure_code: "PROVIDER_FAILED" }), "generation-1", capture))
      .toThrowError(ApiRequestError);
    expect(() => decodeRawMarkdownConversionEnvelope(envelope({ ...base, state: "UNKNOWN", failure_code: "PROVIDER_UNCERTAIN", output_bytes: 1 }), "generation-1", capture))
      .toThrowError(ApiRequestError);
    expect(() => decodeRawMarkdownConversionEnvelope(envelope({ ...complete, tokens: RAW_MARKDOWN_MAX_TOKENS + 1 }), "generation-1", capture))
      .toThrowError(ApiRequestError);
    expect(() => decodeRawMarkdownConversionEnvelope(envelope(complete, "generation-2"), "generation-1", capture))
      .toThrowError(ApiRequestError);
    expect(() => decodeRawMarkdownConversionEnvelope(envelope({ ...complete, capture_id: `raw-capture-${"0".repeat(48)}` }), "generation-1", capture))
      .toThrowError(ApiRequestError);
  });

  it("sends only the server-composed admission identity and accepts a committed receipt", async () => {
    const selected = await prepareRawFileSelection(file("note.txt", "hello"));
    const capture = {
      protocol: "eliotr.raw-file-capture.v1", disposition: "CAPTURED", capture_id: `raw-capture-${"1".repeat(48)}`,
      idempotency_key: selected.idempotency_key, original_file_name: selected.original_file_name,
      content_sha256: selected.content_sha256, size_bytes: selected.size_bytes, content_type: selected.content_type,
      captured_at: "2026-09-09T00:00:00.000Z",
    } as const;
    const conversion = { protocol: "eliotr.raw-markdown-conversion.v1", state: "COMPLETE", operation_id: "2".repeat(64),
      capture_id: capture.capture_id, content_sha256: capture.content_sha256, output_sha256: "3".repeat(64),
      output_bytes: 5, detected_mime: "text/plain", format: "markdown", tokens: 1 } as const;
    const receipt = { operation_id: "bundle-op-1", manifest_sha256: "4".repeat(64), source_revision_ref: "revision-1",
      normalized_artifact_ref: "normalized/artifact", object_residency_key_digest: "5".repeat(64), decision: "ADMITTED",
      reason_codes: [], readback_sha256: "6".repeat(64), committed_at: "2026-09-09T00:00:00.000Z" } as const;
    const admission = { protocol: "eliotr.raw-normalized-admission.v1", admission_operation_id: "a".repeat(64),
      capture_id: capture.capture_id, conversion_operation_id: conversion.operation_id, candidate_ref: `raw-normalized-candidate:${"b".repeat(64)}`,
      state: "COMMITTED", source_revision_ref: "revision-1", source_view_ref: `snapshot-view:v1:${"c".repeat(64)}`, conversion_state: "COMPLETE",
      status: { operation_id: receipt.operation_id, state: "COMMITTED", source_revision_ref: "revision-1", receipt,
        expires_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-09T00:00:00.000Z" },
      admission_receipt: receipt, reason_codes: [], expires_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-09T00:00:00.000Z" };
    const fetchMock = vi.fn(async (_path: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({ idempotency_key: expect.stringMatching(/^raw-admission-[a-f0-9]{64}$/u), conversion_operation_id: conversion.operation_id });
      return new Response(JSON.stringify({ data: admission, trace_id: "trace-admit", deployment_generation: "generation-1" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(admitRawFileToLibrary(capture, conversion, "generation-1")).resolves.toMatchObject({ state: "COMMITTED", admission_receipt: receipt, status: { operation_id: receipt.operation_id } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an admission result that claims COMMITTED without an admitted receipt or adds caller authority fields", async () => {
    const selected = await prepareRawFileSelection(file());
    const capture = { protocol: "eliotr.raw-file-capture.v1", disposition: "CAPTURED", capture_id: `raw-capture-${"8".repeat(48)}`,
      idempotency_key: selected.idempotency_key, original_file_name: selected.original_file_name, content_sha256: selected.content_sha256,
      size_bytes: selected.size_bytes, content_type: selected.content_type, captured_at: "2026-09-09T00:00:00.000Z" } as const;
    const conversion = { protocol: "eliotr.raw-markdown-conversion.v1", state: "COMPLETE", operation_id: "9".repeat(64),
      capture_id: capture.capture_id, content_sha256: capture.content_sha256, output_sha256: "a".repeat(64), output_bytes: 1,
      detected_mime: "text/plain", format: "text", tokens: 0 } as const;
    const result = { protocol: "eliotr.raw-normalized-admission.v1", admission_operation_id: "d".repeat(64), capture_id: capture.capture_id,
      conversion_operation_id: conversion.operation_id, candidate_ref: `raw-normalized-candidate:${"e".repeat(64)}`, state: "COMMITTED", source_revision_ref: "revision-1",
      source_view_ref: `snapshot-view:v1:${"f".repeat(64)}`, conversion_state: "COMPLETE", reason_codes: [], expires_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-09T00:00:00.000Z" };
    const envelope = (data: unknown) => ({ data, trace_id: "trace-admit", deployment_generation: "generation-1" });
    expect(() => decodeRawNormalizedAdmissionEnvelope(envelope(result), "generation-1", capture, conversion)).toThrowError(ApiRequestError);
    expect(() => decodeRawNormalizedAdmissionEnvelope(envelope({ ...result, caller_policy: "allow" }), "generation-1", capture, conversion)).toThrowError(ApiRequestError);
    expect(() => decodeRawNormalizedAdmissionEnvelope(envelope({ ...result,
      status: { operation_id: "1".repeat(64), state: "COMMITTED", source_revision_ref: "revision-1",
        expires_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-09T00:00:00.000Z" },
    }), "generation-1", capture, conversion)).toThrowError(ApiRequestError);
  });
});
