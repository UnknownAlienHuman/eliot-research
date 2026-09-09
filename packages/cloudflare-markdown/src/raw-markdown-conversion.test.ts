import { describe, expect, it, vi } from "vitest";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import { createRawMarkdownConversionService } from "./raw-markdown-conversion.js";
import { parseRawMarkdownConversionRequest, readRawMarkdownConversionRequest } from "./raw-markdown-conversion-contract.js";
import type { RawMarkdownCaptureReceipt, RawMarkdownConversionRequest } from "./raw-markdown-conversion-contract.js";

type Row = Record<string, unknown>;
function fakeDatabase(options: { readonly terminalUpdate?: "zero" | "corrupt" } = {}) {
  const rows = new Map<string, Row>();
  const database = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { args = values; return statement; },
        async first<T>(): Promise<T | null> {
          return (rows.get(String(args[0])) ?? null) as T | null;
        },
        async run() {
          const id = String(args[0]);
          if (sql.startsWith("INSERT")) {
            if (rows.has(id)) throw new Error("UNIQUE");
            rows.set(id, { operation_id: id, principal_ref: args[1], capture_id: args[2], content_sha256: args[3], size_bytes: args[4], request_sha256: args[5], request_json: args[6], authority_sha256: args[7], attempt_id: args[8], state: "STARTED", receipt_object_key: args[9], output_object_key: args[10] });
            return { meta: { changes: 1 } };
          }
          const row = rows.get(id);
          const attemptId = sql.includes("state=?2") ? args[5] : args[4];
          if (row === undefined || row.state !== "STARTED" || row.attempt_id !== attemptId && attemptId !== undefined) return { meta: { changes: 0 } };
          const terminalUpdate = sql.includes("state=?2") || sql.includes("state='FAILED'") || sql.includes("state='UNKNOWN'");
          if (terminalUpdate && options.terminalUpdate === "zero") return { meta: { changes: 0 } };
          if (sql.includes("state='COMPLETE'")) { row.state = "COMPLETE"; row.result_json = args[1]; row.result_sha256 = args[2]; }
          else if (sql.includes("state=?2")) { row.state = args[1]; row.result_json = args[2]; row.result_sha256 = args[3]; }
          else { row.state = sql.includes("state='FAILED'") ? "FAILED" : "UNKNOWN"; row.result_json = args[1]; row.result_sha256 = args[2]; }
          if (terminalUpdate && options.terminalUpdate === "corrupt") row.result_sha256 = "0".repeat(64);
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { database, rows };
}
const bytes = new TextEncoder().encode("%PDF-raw-source");
async function sha256(input: Uint8Array): Promise<string> {
  const copy = new Uint8Array(input.byteLength); copy.set(input);
  const hash = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

describe("durable raw markdown conversion", () => {
  it("bounds the JSON stream before parsing and rejects unknown options", async () => {
    const body = JSON.stringify({ idempotency_key: "bounded", max_output_bytes: 100, max_tokens: 10, timeout_ms: 1_000 });
    const valid = new Request("https://research.example/", { method: "POST", headers: { "content-type": "application/json" }, body });
    await expect(readRawMarkdownConversionRequest(valid, new TextEncoder().encode(body).byteLength)).resolves.toEqual(JSON.parse(body));
    const oversized = new Request("https://research.example/", { method: "POST", headers: { "content-type": "application/json" }, body: `${body}x` });
    await expect(readRawMarkdownConversionRequest(oversized, body.length)).rejects.toThrow();
    const invalidUtf8 = new Request("https://research.example/", { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([0xff]) });
    await expect(readRawMarkdownConversionRequest(invalidUtf8, 16)).resolves.toBeNull();
    expect(parseRawMarkdownConversionRequest({ idempotency_key: "bad", max_output_bytes: 100, max_tokens: 10, timeout_ms: 1_000, conversion_options: { unsupported: true } })).toBeNull();
    expect(parseRawMarkdownConversionRequest({ idempotency_key: "too-large", max_output_bytes: 8 * 1024 * 1024 + 1, max_tokens: 10, timeout_ms: 1_000 })).toBeNull();
  });
  it("rejects a capture over the materialized R2 limit before reserving a provider attempt", async () => {
    const { database, rows } = fakeDatabase();
    const contentSha = await sha256(bytes);
    const capture: RawMarkdownCaptureReceipt = { capture_id: "capture-large", principal_ref: "owner-1", owner_system_id: "system-1", source_namespace_id: "namespace-1", source_revision_ref: "revision-1", source_logical_id: "logical-1", source_owner_generation: "generation-1", original_file_name: "large.pdf", object_key: "raw/capture-large", content_sha256: contentSha, size_bytes: 8 * 1024 * 1024 + 1, content_type: "application/pdf" };
    const provider = vi.fn();
    const service = createRawMarkdownConversionService({ database, profile_generation: "profile-1", adapter: { convert: provider }, source: { read: async () => capture, open: async () => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), assertCurrent: async () => undefined }, output: { putImmutable: async () => ({ key: "unused", readback_sha256: contentSha, size_bytes: bytes.byteLength }), open: async () => null } });
    const result = await service.convert({ principal_ref: "owner-1", credential_generation: "credential-1", deployment_generation: "deployment-1", profile_generation: "profile-1" }, "capture-large", { idempotency_key: "large", max_output_bytes: 100, max_tokens: 10, timeout_ms: 1_000 });
    expect(result).toMatchObject({ state: "FAILED", failure_code: "INVALID_REQUEST" });
    expect(provider).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
  });
  it("settles an abort after reservation as canceled without dispatching the provider", async () => {
    const { database, rows } = fakeDatabase();
    const contentSha = await sha256(bytes);
    const capture: RawMarkdownCaptureReceipt = { capture_id: "capture-abort", principal_ref: "owner-1", owner_system_id: "system-1", source_namespace_id: "namespace-1", source_revision_ref: "revision-1", source_logical_id: "logical-1", source_owner_generation: "generation-1", original_file_name: "abort.pdf", object_key: "raw/capture-abort", content_sha256: contentSha, size_bytes: bytes.byteLength, content_type: "application/pdf" };
    const controller = new AbortController();
    const provider = vi.fn();
    const service = createRawMarkdownConversionService({ database, profile_generation: "profile-1", adapter: { convert: provider }, source: { read: async () => capture, open: async () => { controller.abort(); return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }); }, assertCurrent: async () => undefined }, output: { putImmutable: async () => ({ key: "unused", readback_sha256: contentSha, size_bytes: bytes.byteLength }), open: async () => null } });
    const result = await service.convert({ principal_ref: "owner-1", credential_generation: "credential-1", deployment_generation: "deployment-1", profile_generation: "profile-1", signal: controller.signal }, "capture-abort", { idempotency_key: "abort", max_output_bytes: 100, max_tokens: 10, timeout_ms: 1_000 });
    expect(result).toMatchObject({ state: "FAILED", failure_code: "CANCELED" });
    expect([...rows.values()][0]?.state).toBe("FAILED");
    expect(provider).not.toHaveBeenCalled();
  });
  it("returns uncertain when a terminal CAS has no durable readback", async () => {
    const { database, rows } = fakeDatabase({ terminalUpdate: "zero" });
    const contentSha = await sha256(bytes);
    const capture: RawMarkdownCaptureReceipt = { capture_id: "capture-terminal", principal_ref: "owner-1", owner_system_id: "system-1", source_namespace_id: "namespace-1", source_revision_ref: "revision-1", source_logical_id: "logical-1", source_owner_generation: "generation-1", original_file_name: "missing.pdf", object_key: "raw/capture-terminal", content_sha256: contentSha, size_bytes: bytes.byteLength, content_type: "application/pdf" };
    const provider = vi.fn();
    const service = createRawMarkdownConversionService({ database, profile_generation: "profile-1", adapter: { convert: provider }, source: { read: async () => capture, open: async () => null, assertCurrent: async () => undefined }, output: { putImmutable: async () => ({ key: "unused", readback_sha256: contentSha, size_bytes: bytes.byteLength }), open: async () => null } });
    const result = await service.convert({ principal_ref: "owner-1", credential_generation: "credential-1", deployment_generation: "deployment-1", profile_generation: "profile-1" }, "capture-terminal", { idempotency_key: "terminal", max_output_bytes: 100, max_tokens: 10, timeout_ms: 1_000 });
    expect(result).toMatchObject({ state: "UNKNOWN", failure_code: "PROVIDER_UNCERTAIN" });
    expect([...rows.values()][0]?.state).toBe("STARTED");
    expect(provider).not.toHaveBeenCalled();
  });
  it("reserves one provider attempt and replays its immutable receipt", async () => {
    const { database } = fakeDatabase();
    const contentSha = await sha256(bytes);
    const capture: RawMarkdownCaptureReceipt = { capture_id: "capture-1", principal_ref: "owner-1", owner_system_id: "system-1", source_namespace_id: "namespace-1", source_revision_ref: "revision-1", source_logical_id: "logical-1", source_owner_generation: "generation-1", original_file_name: "note.pdf", object_key: "raw/capture-1", content_sha256: contentSha, size_bytes: bytes.byteLength, content_type: "application/pdf" };
    const output = new Map<string, Uint8Array>();
    const outputAbort = new AbortController();
    let abortDuringOutputReadback = false;
    const provider = vi.fn(async () => ({ disposition: "CONVERTED" as const, context: { operation_id: "", attempt_id: "", input_sha256: contentSha, profile_generation: "profile-1" }, provider_result_id: "provider-1", name: "note.pdf", detected_mime: "application/pdf", format: "markdown" as const, tokens: 2, data: "# Note", data_sha256: await sha256(new TextEncoder().encode("# Note")), data_bytes: 6 }));
    const service = createRawMarkdownConversionService({
      database,
      profile_generation: "profile-1",
      adapter: { convert: provider },
      source: { read: async () => capture, open: async () => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), assertCurrent: async () => undefined },
      output: { putImmutable: async (input) => { const data = new TextEncoder().encode(input.key.endsWith("receipt.json") ? new TextDecoder().decode(await new Response(input.body).arrayBuffer()) : "# Note"); output.set(input.key, data); return { key: input.key, readback_sha256: input.expected_sha256, size_bytes: input.expected_size_bytes }; }, open: async (key) => { const value = output.get(key); if (value !== undefined && abortDuringOutputReadback && key.endsWith("/output.md")) outputAbort.abort(); return value === undefined ? null : { body: new ReadableStream({ start(c) { c.enqueue(value); c.close(); } }) } as R2ObjectBody; } },
    });
    const request: RawMarkdownConversionRequest = { idempotency_key: "conversion-1", max_output_bytes: 100, max_tokens: 10, timeout_ms: 1_000 };
    const reorderedRequest: RawMarkdownConversionRequest = { timeout_ms: 1_000, max_tokens: 10, max_output_bytes: 100, idempotency_key: "conversion-1" };
    const context = { principal_ref: "owner-1", credential_generation: "credential-1", deployment_generation: "deployment-1", profile_generation: "profile-1" };
    const first = await service.convert(context, "capture-1", request);
    const second = await service.convert(context, "capture-1", reorderedRequest);
    expect(first.state).toBe("COMPLETE");
    expect(second).toEqual(first);
    expect(provider).toHaveBeenCalledTimes(1);
    abortDuringOutputReadback = true;
    const abortedReplay = await service.convert({ ...context, signal: outputAbort.signal }, "capture-1", request);
    expect(abortedReplay).toMatchObject({ state: "UNKNOWN", failure_code: "PROVIDER_UNCERTAIN" });
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it("withholds a COMPLETE replay when the persisted result identity is foreign", async () => {
    const { database, rows } = fakeDatabase();
    const contentSha = await sha256(bytes);
    const capture: RawMarkdownCaptureReceipt = { capture_id: "capture-2", principal_ref: "owner-1", owner_system_id: "system-1", source_namespace_id: "namespace-1", source_revision_ref: "revision-1", source_logical_id: "logical-1", source_owner_generation: "generation-1", original_file_name: "note.pdf", object_key: "raw/capture-2", content_sha256: contentSha, size_bytes: bytes.byteLength, content_type: "application/pdf" };
    const provider = vi.fn(async () => ({ disposition: "CONVERTED" as const, context: { operation_id: "", attempt_id: "", input_sha256: contentSha, profile_generation: "profile-1" }, provider_result_id: "provider-2", name: "note.pdf", detected_mime: "application/pdf", format: "markdown" as const, tokens: 2, data: "# Note", data_sha256: await sha256(new TextEncoder().encode("# Note")), data_bytes: 6 }));
    const output = new Map<string, Uint8Array>();
    const service = createRawMarkdownConversionService({ database, profile_generation: "profile-1", adapter: { convert: provider }, source: { read: async () => capture, open: async () => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), assertCurrent: async () => undefined }, output: { putImmutable: async (input) => { const data = new TextEncoder().encode(input.key.endsWith("receipt.json") ? new TextDecoder().decode(await new Response(input.body).arrayBuffer()) : "# Note"); output.set(input.key, data); return { key: input.key, readback_sha256: input.expected_sha256, size_bytes: input.expected_size_bytes }; }, open: async (key) => { const value = output.get(key); return value === undefined ? null : { body: new ReadableStream({ start(c) { c.enqueue(value); c.close(); } }) } as R2ObjectBody; } } });
    const request: RawMarkdownConversionRequest = { idempotency_key: "conversion-2", max_output_bytes: 100, max_tokens: 10, timeout_ms: 1_000 };
    const context = { principal_ref: "owner-1", credential_generation: "credential-1", deployment_generation: "deployment-1", profile_generation: "profile-1" };
    const first = await service.convert(context, "capture-2", request);
    const row = [...rows.values()][0];
    if (row === undefined) throw new Error("durable conversion row was not persisted");
    const foreign = { ...JSON.parse(String(row.result_json)), capture_id: "foreign-capture" };
    row.result_json = JSON.stringify(foreign);
    row.result_sha256 = await canonicalDigest(foreign);
    const second = await service.convert(context, "capture-2", request);
    expect(first.state).toBe("COMPLETE");
    expect(second).toMatchObject({ state: "UNKNOWN", failure_code: "PROVIDER_UNCERTAIN" });
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
