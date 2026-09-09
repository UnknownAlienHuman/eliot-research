import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "./api.js";
import { openEvidence, verifyAndOpenEvidence } from "./evidence-api.js";

const text = "# Evidence\n\nPinned content.\n";
const excerptSha = "be68935765871a5bfe31b5b181eeb420eb917e2d600de7204169df58ecc5c246";
const scope = { id: "scope-1", revision: 1 } as const;
const handle = { id: "handle-1", revision: 1 } as const;

function resolved() {
  return {
    handle: {
      handle_ref: handle, source_namespace_id: "namespace-1", source_owner_generation: "owner-1",
      source_revision_ref: "source-1", scope_snapshot_ref: scope,
      anchor: { kind: "normalized_byte_range", start: 0, end: 28 }, excerpt_sha256: excerptSha,
      excerpt_byte_length: 28, object_residency_key_digest: "b".repeat(64),
      source_assurance_ceiling: "EXACT", materializer_assurance_ceiling: "EXACT", terminal_state: "LIVE",
      created_at: "2026-09-08T00:00:00.000Z",
    },
    exact_excerpt: text, source_title: "Fixture source", verification_receipt_ref: "verify-1",
    authorization_receipt_ref: "authorize-1", credential_generation: "credential-1",
    source_revision_content_sha256: "a".repeat(64), scope_snapshot_digest: "b".repeat(64),
    instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY", resolved_at: "2026-09-08T00:00:00.000Z",
  };
}

function envelope(data: unknown) {
  return { data, trace_id: "trace-1", deployment_generation: "generation-1" };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("evidence verify/open transport", () => {
  it("verifies the selected scope and reopens the same pinned handle", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(init === undefined ? { url } : { url, init });
      if (url.endsWith("/research/verify")) return Response.json(envelope({ resolved_evidence: resolved(), handle: resolved().handle }));
      return new Response(text, { status: 200, headers: {
        "content-type": "text/plain; charset=utf-8", "content-length": "28",
        "x-eliotr-evidence-handle": "handle-1:1", "x-eliotr-excerpt-sha256": excerptSha,
        "x-eliotr-verification-receipt": "verify-1",
      } });
    }));

    const result = await verifyAndOpenEvidence(scope, handle);
    expect(result.text).toBe(text);
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/research/verify", "/api/v1/research/open/handle-1%3A1"]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ scope_snapshot_ref: scope, handle_ref: handle });
    expect(calls[1]?.init?.credentials).toBe("same-origin");
  });

  it("rejects an opened handle that is substituted by the server", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/research/verify")) return Response.json(envelope({ resolved_evidence: resolved(), handle: resolved().handle }));
      return new Response(text, { headers: {
        "content-type": "text/plain", "x-eliotr-evidence-handle": "other-handle:1",
        "x-eliotr-excerpt-sha256": excerptSha, "x-eliotr-verification-receipt": "verify-1",
      } });
    }));
    await expect(verifyAndOpenEvidence(scope, handle)).rejects.toMatchObject({ code: "EVIDENCE_RESPONSE_INVALID" });
  });

  it("rejects invalid UTF-8 from research.open", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([255]), { headers: {
      "content-type": "text/plain", "x-eliotr-evidence-handle": "handle-1:1",
      "x-eliotr-excerpt-sha256": excerptSha, "x-eliotr-verification-receipt": "verify-1",
    } })));
    await expect(openEvidence(handle)).rejects.toBeInstanceOf(ApiRequestError);
  });

  it("bounds a stalled text response and aborts its reader", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const pending = expect(openEvidence(handle)).rejects.toMatchObject({ code: "API_REQUEST_ABORTED" });
    await vi.advanceTimersByTimeAsync(30001);
    await pending;
  });
});
