import { describe, expect, it } from "vitest";
import { modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { summarizeCatalogModelProbeHttpFailure } from "./research-catalog-model-v2-probe-executor.js";

describe("safe failed catalog probe diagnostics", () => {
  it.each([
    [400, { error: { code: "private-provider-code", message: "private provider payload and key" } }, "MODEL_GATEWAY_UPSTREAM_REJECTED", []],
    [403, { error: { message: "private authentication detail" } }, "MODEL_GATEWAY_AUTH_REJECTED", []],
    [400, { errors: [{ code: 2003, message: "private limit detail" }] }, "MODEL_GATEWAY_LIMIT_REJECTED", [2003]],
    [400, { errors: [{ code: 2016, message: "private policy detail" }] }, "MODEL_GATEWAY_POLICY_REJECTED", [2016]],
    [502, { code: 9999, message: "private upstream failure" }, "MODEL_GATEWAY_UPSTREAM_REJECTED", [9999]],
  ] as const)("captures HTTP %s as bounded classification and digest only", async (status, body, code, codes) => {
    const json = JSON.stringify(body);
    const summary = await summarizeCatalogModelProbeHttpFailure(new Response(json, { status }), new AbortController().signal);
    expect(summary).toEqual({ response_digest_scope: "FULL", response_bytes_captured: new TextEncoder().encode(json).byteLength,
      response_sha256: await modelGatewaySha256(json), error_code: code, upstream_error_codes: codes });
    expect(JSON.stringify(summary)).not.toMatch(/private/u);
  });

  it("labels an oversized body's digest as a prefix and never parses partial codes", async () => {
    const body = JSON.stringify({ error: { code: 2003, message: "x".repeat(20_000) } });
    const summary = await summarizeCatalogModelProbeHttpFailure(new Response(body, { status: 400 }), new AbortController().signal);
    expect(summary).toEqual({ response_digest_scope: "PREFIX", response_bytes_captured: 16_384,
      response_sha256: await modelGatewaySha256(new TextEncoder().encode(body).slice(0, 16_384)),
      error_code: "HTTP_ERROR_BODY_INCOMPLETE", upstream_error_codes: [] });
  });

  it("captures a digest for non-JSON errors without copying text into telemetry", async () => {
    const body = "private HTML or text error";
    const summary = await summarizeCatalogModelProbeHttpFailure(new Response(body, { status: 400 }), new AbortController().signal);
    expect(summary).toMatchObject({ response_digest_scope: "FULL", response_sha256: await modelGatewaySha256(body),
      error_code: "MODEL_GATEWAY_UPSTREAM_REJECTED", upstream_error_codes: [] });
    expect(JSON.stringify(summary)).not.toContain(body);
  });

  it("aborts a stalled error stream under the existing request signal", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode("private prefix")); },
      cancel() { cancelled = true; },
    }), { status: 400 });
    const pending = summarizeCatalogModelProbeHttpFailure(response, controller.signal);
    await Promise.resolve();
    controller.abort();
    const summary = await pending;
    expect(summary.response_digest_scope).toBe("PREFIX");
    expect(summary.response_bytes_captured).toBeLessThanOrEqual(16_384);
    expect(summary.upstream_error_codes).toEqual([]);
    expect(cancelled).toBe(true);
  });
});
