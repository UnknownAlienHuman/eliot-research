import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { createApplication } from "../src/composition-root.js";
import { handleHttp } from "../src/http.js";
import { prepareQ1Namespace, type Q1Runtime } from "./retrieval-q1-fixture.js";

const runtime = env as unknown as Q1Runtime & Env;
function access(principal: string) { return { accessVerifier: { async verify() { return { principal_ref: principal, credential_generation: "credential-markdown-1", authentication_method: "cloudflare_access" as const, expires_at: new Date(Date.now() + 3_600_000).toISOString() }; } } }; }
async function sha(bytes: Uint8Array): Promise<string> { const copy = new Uint8Array(bytes); const hash = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer); return [...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, "0")).join(""); }
function captureRequest(bytes: Uint8Array, digest: string): Request { return new Request("https://research.example/api/v1/ingest/raw", { method: "POST", headers: { "content-type": "application/pdf", "content-length": String(bytes.byteLength), "idempotency-key": "markdown-capture-1", "x-eliotr-original-file-name": "note.pdf", "x-eliotr-content-sha256": digest }, body: bytes.buffer as ArrayBuffer }); }
function conversionRequest(captureId: string, idempotencyKey = "markdown-convert-1", signal?: AbortSignal, payload: Record<string, unknown> = { idempotency_key: idempotencyKey, max_output_bytes: 1_000, max_tokens: 100, timeout_ms: 1_000 }): Request { return new Request(`https://research.example/api/v1/ingest/raw/${captureId}/markdown`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), ...(signal === undefined ? {} : { signal }) }); }

describe("durable raw markdown Worker path", () => {
  it("reads the canonical raw capture, persists output, and replays without a second binding call", async () => {
    await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
    const owner = `markdown-owner-${crypto.randomUUID()}`; await prepareQ1Namespace(runtime, runtime.CORE_DB, runtime.SEARCH_DB, owner);
    const bytes = new TextEncoder().encode("%PDF controlled raw bytes"); const digest = await sha(bytes); const calls = vi.fn(async () => ({ id: "provider-1", name: "note.pdf", format: "markdown" as const, mimetype: "application/pdf", tokens: 2, data: "# Note" }));
    const ai = { toMarkdown: calls };
    const testEnv = { ...runtime, AI: ai } as unknown as Env;
    const factory = () => createApplication({ env: testEnv, executionContext: {} as ExecutionContext });
    const first = await handleHttp(captureRequest(bytes, digest), testEnv, {} as ExecutionContext, access(owner)); expect(first.status).toBe(200);
    const captureId = ((await first.json()) as { data: { capture_id: string } }).data.capture_id;
    const oversized = await handleHttp(conversionRequest(captureId, "markdown-oversized", undefined, { idempotency_key: "markdown-oversized", max_output_bytes: 1_000, max_tokens: 100, timeout_ms: 1_000, padding: "x".repeat(20_000) }), testEnv, {} as ExecutionContext, { ...access(owner), applicationFactory: factory }); expect(oversized.status).toBe(413);
    const unknownOptions = await handleHttp(conversionRequest(captureId, "markdown-unknown-options", undefined, { idempotency_key: "markdown-unknown-options", max_output_bytes: 1_000, max_tokens: 100, timeout_ms: 1_000, conversion_options: { unsupported: true } }), testEnv, {} as ExecutionContext, { ...access(owner), applicationFactory: factory }); expect(unknownOptions.status).toBe(400); expect(calls).toHaveBeenCalledTimes(0);
    const converted = await handleHttp(conversionRequest(captureId), testEnv, {} as ExecutionContext, { ...access(owner), applicationFactory: factory }); expect(converted.status).toBe(200);
    const result = (await converted.json() as { data: { state: string; output_sha256?: string; output_bytes?: number } }).data;
    expect(result).toMatchObject({ state: "COMPLETE", output_bytes: 6 }); expect(result.output_sha256).toBe(await sha(new TextEncoder().encode("# Note"))); expect(calls).toHaveBeenCalledTimes(1);
    await runtime.CORE_DB.prepare("UPDATE raw_markdown_conversion SET state='STARTED',result_json=NULL,result_sha256=NULL WHERE capture_id=?1").bind(captureId).run();
    const replay = await handleHttp(conversionRequest(captureId), testEnv, {} as ExecutionContext, { ...access(owner), applicationFactory: factory }); expect(replay.status).toBe(200); expect((await replay.json() as { data: unknown }).data).toEqual(result); expect(calls).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort();
    const canceled = await handleHttp(conversionRequest(captureId, "markdown-cancel-1", controller.signal), testEnv, {} as ExecutionContext, { ...access(owner), applicationFactory: factory });
    expect(canceled.status).toBe(200); expect(await canceled.json()).toMatchObject({ data: { state: "FAILED", failure_code: "CANCELED" } }); expect(calls).toHaveBeenCalledTimes(1);
    const row = await runtime.CORE_DB.prepare("SELECT state,output_object_key,receipt_object_key FROM raw_markdown_conversion WHERE capture_id=?1").bind(captureId).first<{ state: string; output_object_key: string; receipt_object_key: string }>(); expect(row?.state).toBe("COMPLETE"); expect(await runtime.EVIDENCE_BUCKET.head(row?.output_object_key ?? "")).not.toBeNull(); expect(await runtime.EVIDENCE_BUCKET.head(row?.receipt_object_key ?? "")).not.toBeNull();
    await runtime.EVIDENCE_BUCKET.put(row?.output_object_key ?? "", "corrupt-output");
    const corrupted = await handleHttp(conversionRequest(captureId), testEnv, {} as ExecutionContext, { ...access(owner), applicationFactory: factory }); expect(corrupted.status).toBe(200); expect(await corrupted.json()).toMatchObject({ data: { state: "UNKNOWN", failure_code: "PROVIDER_UNCERTAIN" } }); expect(calls).toHaveBeenCalledTimes(1);
  });
});
