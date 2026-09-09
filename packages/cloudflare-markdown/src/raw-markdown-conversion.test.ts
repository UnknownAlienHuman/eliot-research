import { describe, expect, it, vi } from "vitest";
import { createRawMarkdownConversionService } from "./raw-markdown-conversion.js";
import type { RawMarkdownCaptureReceipt, RawMarkdownConversionRequest } from "./raw-markdown-conversion-contract.js";

type Row = Record<string, unknown>;
function fakeDatabase() {
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
          if (row === undefined || row.state !== "STARTED" || row.attempt_id !== args[4] && args[4] !== undefined) return { meta: { changes: 0 } };
          if (sql.includes("state='COMPLETE'")) { row.state = "COMPLETE"; row.result_json = args[1]; row.result_sha256 = args[2]; }
          else { row.state = args[1]; row.result_json = args[2]; }
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
  it("reserves one provider attempt and replays its immutable receipt", async () => {
    const { database } = fakeDatabase();
    const contentSha = await sha256(bytes);
    const capture: RawMarkdownCaptureReceipt = { capture_id: "capture-1", principal_ref: "owner-1", owner_system_id: "system-1", source_namespace_id: "namespace-1", source_revision_ref: "revision-1", source_logical_id: "logical-1", source_owner_generation: "generation-1", original_file_name: "note.pdf", object_key: "raw/capture-1", content_sha256: contentSha, size_bytes: bytes.byteLength, content_type: "application/pdf" };
    const output = new Map<string, Uint8Array>();
    const provider = vi.fn(async () => ({ disposition: "CONVERTED" as const, context: { operation_id: "", attempt_id: "", input_sha256: contentSha, profile_generation: "profile-1" }, provider_result_id: "provider-1", name: "note.pdf", detected_mime: "application/pdf", format: "markdown" as const, tokens: 2, data: "# Note", data_sha256: await sha256(new TextEncoder().encode("# Note")), data_bytes: 6 }));
    const service = createRawMarkdownConversionService({
      database,
      profile_generation: "profile-1",
      adapter: { convert: provider },
      source: { read: async () => capture, open: async () => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), assertCurrent: async () => undefined },
      output: { putImmutable: async (input) => { const data = new TextEncoder().encode(input.key.endsWith("receipt.json") ? new TextDecoder().decode(await new Response(input.body).arrayBuffer()) : "# Note"); output.set(input.key, data); return { key: input.key, readback_sha256: input.expected_sha256, size_bytes: input.expected_size_bytes }; }, open: async (key) => { const value = output.get(key); return value === undefined ? null : { body: new ReadableStream({ start(c) { c.enqueue(value); c.close(); } }) } as R2ObjectBody; } },
    });
    const request: RawMarkdownConversionRequest = { idempotency_key: "conversion-1", max_output_bytes: 100, max_tokens: 10, timeout_ms: 1_000 };
    const context = { principal_ref: "owner-1", credential_generation: "credential-1", deployment_generation: "deployment-1", profile_generation: "profile-1" };
    const first = await service.convert(context, "capture-1", request);
    const second = await service.convert(context, "capture-1", request);
    expect(first.state).toBe("COMPLETE");
    expect(second).toEqual(first);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it("withholds a COMPLETE replay when the durable result digest is tampered", async () => {
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
    row.result_sha256 = "0".repeat(64);
    const second = await service.convert(context, "capture-2", request);
    expect(first.state).toBe("COMPLETE");
    expect(second).toMatchObject({ state: "UNKNOWN", failure_code: "PROVIDER_UNCERTAIN" });
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
