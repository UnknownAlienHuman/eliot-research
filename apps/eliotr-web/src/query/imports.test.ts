import { describe, expect, it, vi } from "vitest";
import { BROWSER_BUNDLE_LIMITS } from "@eliotr/owner-api-client";
import type { RawFileCaptureReceipt, RawMarkdownConversionRequest, SourceNamespaceCatalog } from "@eliotr/owner-api-client";
import { createWorkspaceRuntime } from "../app/runtime";
import { createPrivacyController } from "../app/privacy";
import { createWorkspaceQueryClient, clearWorkspaceQueries } from "./client";
import { importActions } from "./imports";

/** Three import behaviors proven through the real protected runtime rather than a mocked helper. */
const generation = "deployment-1";
const stamp = "2026-10-09T12:00:00.000Z";
const namespaceId = "namespace-1";
/** A typed catalog. Profile rows and optional read-access fields are omitted, not invented. */
const catalog: SourceNamespaceCatalog = {
  protocol: "eliotr.owner-namespaces.v1",
  profiles: [],
  namespaces: [{ source_namespace_id: namespaceId, title: "Research workspace" }],
  trace_id: "trace-1",
  deployment_generation: generation,
};
/** A typed capture receipt. Protocol and disposition use their literal types. */
const capture: RawFileCaptureReceipt = {
  protocol: "eliotr.raw-file-capture.v1",
  disposition: "CAPTURED",
  capture_id: "raw-capture-" + "b".repeat(48),
  idempotency_key: "raw-upload-" + "c".repeat(64),
  original_file_name: "notes.md",
  content_sha256: "d".repeat(64),
  size_bytes: 128,
  content_type: "text/markdown",
  captured_at: stamp,
};
/**
 * A conversion request whose every field is caller-chosen. Both wire assertions compare against this
 * exact object, so a drift in key, bounds or options is visible rather than absorbed.
 */
const selectedRequest: RawMarkdownConversionRequest = {
  idempotency_key: "raw-markdown-" + "a".repeat(64),
  max_output_bytes: 1024,
  max_tokens: 4096,
  timeout_ms: 300_000,
  conversion_options: { output: { format: "markdown" } },
};
/** A typed UNKNOWN outcome. failure_code is required for both FAILED and UNKNOWN. */
const unknownConversion = {
  protocol: "eliotr.raw-markdown-conversion.v1",
  state: "UNKNOWN",
  operation_id: "e".repeat(64),
  capture_id: capture.capture_id,
  content_sha256: capture.content_sha256,
  failure_code: "PROVIDER_UNCERTAIN",
};
const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: "trace-1", deployment_generation: generation }),
  { headers: { "content-type": "application/json" } });
const timers = { setTimeout: () => 0, clearTimeout() {} };

/**
 * A real File. arrayBuffer is spied rather than stubbed, so the oversize test observes the actual
 * browser object refusing to be read before the guard rejects it.
 */
function realFile(bytes: number, name = "page.md"): File {
  const file = new File([new Uint8Array(Math.min(bytes, 1024))], name, { type: "text/markdown" });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

interface Fixture {
  readonly actions: ReturnType<typeof importActions>;
  readonly mint: ReturnType<typeof vi.fn<() => string>>;
  readonly fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  readonly digest: { readonly entered: () => boolean; readonly release: () => void };
  readonly armDigestBarrier: () => void;
  hide(): void;
  dispose(): void;
}

/**
 * Builds the real runtime. sha256 is deferred so a test can hold the digest open and invalidate the
 * session before it resolves, which is the only way to reach the epoch fence on the capture path.
 */
async function fixture(): Promise<Fixture> {
  const client = createWorkspaceQueryClient();
  let sessionCurrent = true;
  let entered = false;
  let releaseDigest: (() => void) | undefined;
  // Digests resolve immediately unless a test arms the barrier, so only the fence test blocks.
  let barrier = false;
  const fetcher = vi.fn<typeof fetch>(async input => {
    const path = String(input);
    if (path === "/api/v1/system/health") return json({ ready: true, deployment_generation: generation,
      core_schema_generation: "schema-1", search_schema_generation: "schema-1", blocking_reason_codes: [], checked_at: stamp });
    if (path === "/api/v1/system/session") return json({ protocol: "eliotr.owner-session.v1",
      principal_ref: "owner-1", credential_generation: "credentials-1", client_class: "owner_pwa", expires_at: "2027-01-01T00:00:00.000Z" });
    // The conversion readback is a typed UNKNOWN outcome, which is what a reconciliation really sees.
    return json(path.includes("/markdown") ? unknownConversion : {});
  });
  const mint = vi.fn(() => "11111111-1111-4111-8111-111111111111");
  const runtime = createWorkspaceRuntime({ fetch: fetcher, baseUrl: "https://owner.example", timers,
    now: () => Date.parse(stamp), mint,
    sha256: () => new Promise<string>(resolve => {
      if (!barrier) { resolve("a".repeat(64)); return; }
      entered = true;
      releaseDigest = () => resolve("a".repeat(64));
    }),
    isCurrent: () => sessionCurrent, onAuthorizationLoss() { sessionCurrent = false; privacy.close(); } });
  const privacy = createPrivacyController({ now: () => Date.parse(stamp), timers,
    mask() { runtime.close(); }, reveal() {}, cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); },
    clearProtected() { clearWorkspaceQueries(client); }, verify: signal => runtime.verify(signal) });
  await privacy.refresh();
  const snapshot = privacy.getSnapshot();
  if (snapshot.phase !== "available") throw new Error("Actual bootstrap failed");
  runtime.bind(snapshot.context);
  const apis = runtime.read(snapshot.context);
  if (!apis) throw new Error("Actual binding failed");
  const actions = importActions(apis.sources, privacy, snapshot.context, () => catalog);
  fetcher.mockClear();
  mint.mockClear();
  return { actions, mint, fetcher,
    armDigestBarrier() { barrier = true; },
    digest: { entered: () => entered, release: () => releaseDigest?.() },
    hide() { sessionCurrent = false; privacy.close(); },
    dispose() { privacy.dispose(); runtime.dispose(); client.clear(); } };
}

describe("explicit import actions through the actual protected runtime", () => {
  it("rejects an oversized bundle before any byte read, HTTP call or identity mint", async () => {
    const test = await fixture();
    const files = [realFile(BROWSER_BUNDLE_LIMITS.file_bytes + 1, "huge.md"), realFile(64, "index.md"), realFile(64, "manifest.json")];
    const reads = files.map(file => vi.spyOn(file, "arrayBuffer"));
    await expect(test.actions.prepareBundle(files, new AbortController().signal))
      .rejects.toThrow("exceeds the browser import profile");
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(test.mint).not.toHaveBeenCalled();
    test.dispose();
  });

  it("blocks a protected capture when the session is invalidated while the digest is in flight", async () => {
    const test = await fixture();
    test.armDigestBarrier();
    // The digest is held open until it is provably entered, so the close lands inside the await.
    const pending = test.actions.prepare(realFile(128), catalog, namespaceId, new AbortController().signal);
    while (!test.digest.entered()) await Promise.resolve();
    test.hide();
    test.digest.release();
    await expect(pending).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(test.mint).not.toHaveBeenCalled();
    test.dispose();
  });

  it("reconciles the same explicit conversion request twice, with no new identity minted", async () => {
    const test = await fixture();
    const signal = new AbortController().signal;
    const key = await test.actions.conversionKey(capture, signal);
    expect(key).toMatch(/^raw-markdown-[a-f0-9]{64}$/u);
    // The caller-chosen request is what the browser sends, unchanged on both calls.
    const request = { ...selectedRequest, idempotency_key: key };
    // A typed UNKNOWN outcome is a successful reconciliation, not an error. Both calls resolve to it.
    const first = await test.actions.convert(capture, request, signal);
    const second = await test.actions.convert(capture, request, signal);
    expect(first).toMatchObject({ state: "UNKNOWN", failure_code: "PROVIDER_UNCERTAIN" });
    expect(second).toEqual(first);
    expect(test.fetcher).toHaveBeenCalledTimes(2);
    for (const call of test.fetcher.mock.calls) {
      expect(String(call[0])).toBe(`/api/v1/ingest/raw/${capture.capture_id}/markdown`);
      expect(call[1]?.method).toBe("POST");
      expect(new Headers(call[1]?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(call[1]?.body))).toEqual(request);
    }
    // Reconciliation is not new intent: the mint serves only an explicit new owner action.
    expect(test.mint).not.toHaveBeenCalled();
    test.dispose();
  });
});
