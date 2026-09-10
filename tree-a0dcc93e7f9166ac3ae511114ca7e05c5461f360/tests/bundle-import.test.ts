import { describe, expect, it, vi } from "vitest";
import { bundleFixture } from "../packages/platform-cloudflare/src/ingest-test-fixture.js";
import { canonicalDigest } from "../packages/platform-cloudflare/src/d1-ingest-validation.js";
import { prepareBrowserBundle, selectedBundleFiles, safeBundlePath } from "../apps/eliotr-pwa/src/bundle-input.js";
import { createBrowserBundleImport, importBrowserBundle } from "../apps/eliotr-pwa/src/bundle-import.js";
import { decodePrepared, readImportStatus, type ImportIdentity, type ImportTransport } from "../apps/eliotr-pwa/src/bundle-import-api.js";

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing fixture value"); return value;
}
async function fixture() {
  const raw = await bundleFixture();
  const files = Object.entries(raw.files).map(([path, bytes]) => ({ path, blob: new Blob([new Uint8Array(bytes)]) }));
  const bundle = await prepareBrowserBundle(files);
  const identity: ImportIdentity = { operation: "ingest-test", manifestDigest: await canonicalDigest(raw.manifest),
    sourceRevision: raw.manifest.origin.source_revision_ref, generation: "test-generation" };
  const prepared = { operation_id: identity.operation, manifest_sha256: identity.manifestDigest, disposition: "UPLOAD_REQUIRED",
    multipart_session_ref: "session-1", expires_at: new Date(Date.now() + 3600000).toISOString(), reason_codes: [],
    files: bundle.files.map((file) => ({ path: file.path, expected_sha256: bundle.hashes[file.path], max_part_bytes: 8 * 1024 * 1024 })) };
  const receipt = { operation_id: identity.operation, manifest_sha256: identity.manifestDigest, source_revision_ref: identity.sourceRevision,
    normalized_artifact_ref: "artifact-1", object_residency_key_digest: "a".repeat(64), decision: "ADMITTED",
    reason_codes: [], readback_sha256: "b".repeat(64), committed_at: new Date().toISOString() };
  const status = { operation_id: identity.operation, source_revision_ref: identity.sourceRevision, state: "COMMITTED", staging_session_ref: "session-1",
    receipt, expires_at: prepared.expires_at, updated_at: receipt.committed_at };
  const envelope = (data: unknown, generation = identity.generation) => ({ data, trace_id: "trace-1", deployment_generation: generation });
  const calls: { path: string; init: RequestInit }[] = [];
  const transport: ImportTransport = async (path, init = {}) => {
    calls.push({ path, init });
    if (path.endsWith("/prepare")) return envelope(prepared);
    if (path.includes("/parts/")) {
      const url = new URL(path, "https://test.invalid"); const part = url.searchParams;
      return envelope({ operation_id: identity.operation, multipart_session_ref: "session-1", path: part.get("path"),
        part_number: Number(url.pathname.split("/").at(-1)), size_bytes: Number(part.get("size_bytes")), etag: "etag-part" });
    }
    if (path.endsWith("/files/complete")) {
      const body = JSON.parse(String(init.body)) as { path: string };
      return envelope({ operation_id: identity.operation, multipart_session_ref: "session-1", path: body.path,
        sha256: bundle.hashes[body.path], size_bytes: bundle.files.find((file) => file.path === body.path)?.blob.size,
        etag: "etag-complete", completed_at: receipt.committed_at });
    }
    if (path.endsWith("/commit")) return envelope(receipt);
    return envelope(status);
  };
  return { raw, files, bundle, identity, prepared, receipt, status, envelope, calls, transport };
}

describe("browser normalized bundle input", () => {
  it("snapshots original bytes and checks the real hash list", async () => {
    const f = await fixture();
    expect(f.bundle.hashes).toEqual(f.raw.hashes); expect(f.bundle.totalBytes).toBe(f.raw.totalBytes);
    expect(f.bundle.files[0]?.blob).not.toBe(f.files[0]?.blob);
    expect(f.identity.manifestDigest).not.toBe(f.bundle.hashes["manifest.json"]);
  });
  it.each(["../x", "/x", "x//y", "x/../y", "x\\y", "x%2fy", "", "__proto__"])("rejects unsafe path %s", (path) => {
    expect(() => safeBundlePath(path)).toThrow();
  });
  it("rejects duplicates, missing and oversized files before reading blobs", async () => {
    const f = await fixture(); const read = vi.spyOn(required(f.files[0]).blob, "arrayBuffer");
    await expect(prepareBrowserBundle([...f.files, required(f.files[0])])).rejects.toThrow();
    await expect(prepareBrowserBundle(f.files.filter((file) => file.path !== "manifest.json"))).rejects.toThrow();
    await expect(prepareBrowserBundle([...f.files, { path: "assets/large", blob: new Blob([new Uint8Array(16 * 1024 * 1024 + 1)]) }])).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects checksum, UTF-8, undeclared file and strict manifest mismatch", async () => {
    const f = await fixture();
    for (const [path, blob] of [["content.md", new Blob(["changed"])], ["manifest.json", new Blob([new Uint8Array([255])])],
      ["manifest.json", new Blob([JSON.stringify({ ...f.raw.manifest, unknown: true })])],
      ["hashes.sha256", new Blob(["a".repeat(64) + "  hashes.sha256\n"])]] as const) {
      await expect(prepareBrowserBundle(f.files.map((file) => file.path === path ? { path, blob } : file))).rejects.toThrow();
    }
    await expect(prepareBrowserBundle([...f.files, { path: "undeclared.txt", blob: new Blob(["x"]) }])).rejects.toThrow();
  });
  it("stops before hashing or any transport when already cancelled", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(prepareBrowserBundle(f.files, controller.signal)).rejects.toMatchObject({ code: "BUNDLE_IMPORT_CANCELLED" });
    await expect(importBrowserBundle(f.bundle, "key", { signal: controller.signal, transport: f.transport })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  it("preserves nested folder paths and rejects mixed roots", () => {
    const file = (path: string) => { const value = new File(["x"], required(path.split("/").at(-1)));
      Object.defineProperty(value, "webkitRelativePath", { value: path }); return value; };
    expect(selectedBundleFiles([file("root/assets/table.json")])[0]?.path).toBe("assets/table.json");
    expect(() => selectedBundleFiles([file("a/content.md"), file("b/manifest.json")])).toThrow();
    expect(() => selectedBundleFiles([file("a/content.md"), new File(["x"], "manifest.json")])).toThrow();
  });
});

describe("browser import protocol", () => {
  it("uploads exact bytes and commits the server canonical digest, then reads status", async () => {
    const f = await fixture(); const progress: string[] = [];
    expect(await importBrowserBundle(f.bundle, "stable-key", { transport: f.transport, onProgress: (event) => progress.push(event.phase) })).toEqual(f.receipt);
    const prepare = JSON.parse(String(f.calls[0]?.init.body)); expect(prepare.idempotency_key).toBe("stable-key");
    const commit = required(f.calls.find((call) => call.path.endsWith("/commit")));
    expect(JSON.parse(String(commit.init.body)).manifest_sha256).toBe(f.identity.manifestDigest);
    expect(f.calls.at(-1)?.path).toBe("/api/v1/ingest/bundles/ingest-test");
    expect(f.calls.filter((call) => call.init.method === "PUT")).toHaveLength(3);
    expect(progress.at(-1)).toBe("Admitted; search index readiness is separate");
  });
  it("does not upload a duplicate; rechecks its durable receipt", async () => {
    const f = await fixture(); const transport: ImportTransport = async (path, init) => path.endsWith("/prepare")
      ? f.envelope({ operation_id: f.identity.operation, manifest_sha256: f.identity.manifestDigest, disposition: "DUPLICATE",
        expires_at: f.prepared.expires_at, reason_codes: [], existing_receipt: f.receipt }) : f.transport(path, init);
    expect(await importBrowserBundle(f.bundle, "key", { transport })).toEqual(f.receipt);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]?.init.method).toBeUndefined();
  });
  it("does not promote a rejected prepare", async () => {
    const f = await fixture(); const transport = vi.fn(async () => f.envelope({ operation_id: "ingest-test",
      manifest_sha256: f.identity.manifestDigest, disposition: "REJECTED", expires_at: f.prepared.expires_at, reason_codes: ["DENIED"] }));
    expect(await importBrowserBundle(f.bundle, "key", { transport })).toBeNull(); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects missing canonical digest, duplicate/foreign files, size and expiry drift", async () => {
    const f = await fixture();
    for (const fields of [{ manifest_sha256: undefined }, { files: [f.prepared.files[0], f.prepared.files[0], f.prepared.files[0]] },
      { files: f.prepared.files.map((file) => ({ ...file, expected_sha256: "0".repeat(64) })) },
      { files: f.prepared.files.map((file) => ({ ...file, max_part_bytes: 1 })) }, { expires_at: "2000-01-01T00:00:00Z" },
      { extra: true }]) expect(() => decodePrepared({ ...f.prepared, ...fields }, f.bundle, f.identity.generation)).toThrow();
  });
  it("rejects part/file identity drift before completing or committing", async () => {
    for (const where of ["/parts/", "/files/complete"]) {
      const f = await fixture(); const transport: ImportTransport = async (path, init) => {
        const value = await f.transport(path, init) as { data: Record<string, unknown> };
        return path.includes(where) ? { ...value, data: { ...value.data, operation_id: "foreign" } } : value;
      };
      await expect(importBrowserBundle(f.bundle, "key", { transport })).rejects.toMatchObject({ code: "INGEST_RESPONSE_MISMATCH" });
      expect(f.calls.some((call) => call.path.endsWith("/commit"))).toBe(false);
    }
  });
  it("never automatically resends a mutation after a lost acknowledgement", async () => {
    const f = await fixture(); const transport: ImportTransport = async (path, init) => {
      const result = await f.transport(path, init);
      if (path.includes("/parts/")) throw new Error("lost ack"); return result;
    };
    await expect(importBrowserBundle(f.bundle, "key", { transport })).rejects.toThrow("lost ack");
    expect(f.calls.filter((call) => call.init.method === "PUT")).toHaveLength(1);
    expect(f.calls.some((call) => call.path.endsWith("/commit"))).toBe(false);
  });
  it("stops after cancellation during prepare, before sending file bytes", async () => {
    const f = await fixture(); const controller = new AbortController();
    await expect(importBrowserBundle(f.bundle, "key", { transport: f.transport, signal: controller.signal,
      onIdentity: () => controller.abort() })).rejects.toMatchObject({ code: "BUNDLE_IMPORT_CANCELLED" });
    expect(f.calls).toHaveLength(1);
  });
  it("rejects generation drift and forged terminal receipts", async () => {
    for (const mode of ["generation", "receipt", "status"]) {
      const f = await fixture(); const transport: ImportTransport = async (path, init) => {
        const result = await f.transport(path, init);
        if (mode === "generation" && path.includes("/parts/")) return f.envelope({}, "other");
        if (mode === "receipt" && path.endsWith("/commit")) return f.envelope({ ...f.receipt, source_revision_ref: "foreign" });
        if (mode === "status" && path.endsWith("ingest-test")) return f.envelope({ ...f.status, receipt: undefined });
        return result;
      };
      await expect(importBrowserBundle(f.bundle, "key", { transport })).rejects.toMatchObject({ code: "INGEST_RESPONSE_MISMATCH" });
    }
  });
  it("does not present an intermediate operation as committed", async () => {
    const f = await fixture(); const { receipt: _receipt, ...fields } = f.status;
    expect(await readImportStatus(f.identity, undefined, async () => f.envelope({ ...fields, state: "UPLOAD_REQUIRED" })))
      .toEqual({ state: "UPLOAD_REQUIRED" });
  });
  it("splits a multi-part file into negotiated full parts and the exact final bytes", async () => {
    const f = await fixture();
    const path = "assets/large.bin"; const size = 8 * 1024 * 1024 + 17;
    const blob = new Blob([new Uint8Array(size)]);
    const hashes = { ...f.bundle.hashes, [path]: "d".repeat(64) };
    const bundle = { ...f.bundle, hashes, files: [...f.bundle.files, { path, blob }], totalBytes: f.bundle.totalBytes + size };
    const transport: ImportTransport = async (url, init) => {
      if (url.endsWith("/prepare")) return f.envelope({ ...f.prepared,
        files: [...f.prepared.files, { path, expected_sha256: hashes[path], max_part_bytes: 8 * 1024 * 1024 }] });
      if (url.endsWith("/files/complete") && String(init?.body).includes(path)) {
        f.calls.push({ path: url, init: init ?? {} });
        return f.envelope({ operation_id: f.identity.operation, multipart_session_ref: "session-1", path,
          sha256: hashes[path], size_bytes: size, etag: "opaque+etag=", completed_at: f.receipt.committed_at });
      }
      return f.transport(url, init);
    };
    await importBrowserBundle(bundle, "multipart", { transport });
    const parts = f.calls.filter((call) => call.path.includes("path=assets%2Flarge.bin"));
    expect(parts.map((call) => (call.init.body as Blob).size)).toEqual([8 * 1024 * 1024, 17]);
    expect(parts.map((call) => new URL(call.path, "https://test.invalid").searchParams.get("final_part"))).toEqual(["0", "1"]);
    const complete = required(f.calls.find((call) => call.path.endsWith("/files/complete") && String(call.init.body).includes(path)));
    expect(JSON.parse(String(complete.init.body)).parts.map((part: { part_number: number }) => part.part_number)).toEqual([1, 2]);
  });

});


describe("explicit same-tab upload continuation", () => {
  it.each(["part-before", "part-after", "complete-before", "complete-after", "commit-before", "commit-after", "status"])("recovers %s interruption without a new operation or resending acknowledged bytes", async (failure) => {
    const f = await fixture(); let failed = false; let committed = false;
    const sent: { path: string; init?: RequestInit }[] = [];
    const transport: ImportTransport = async (path, init) => {
      sent.push({ path, ...(init ? { init } : {}) });
      const kind = path.includes("/parts/") ? "part" : path.endsWith("/files/complete") ? "complete" :
        path.endsWith("/commit") ? "commit" : path.endsWith("/prepare") ? "prepare" : "status";
      if (!failed && failure === `${kind}-before`) { failed = true; throw new Error("interrupted"); }
      if (kind === "commit") committed = true;
      const result = kind === "status" && !committed ? f.envelope({ ...f.status, receipt: undefined, state: "UPLOAD_REQUIRED",
        staging_session_ref: "session-1" }) : await f.transport(path, init);
      if (!failed && (failure === `${kind}-after` || failure === kind && committed)) { failed = true; throw new Error("interrupted"); }
      return result;
    };
    const attempt = createBrowserBundleImport(f.bundle, "same-operation");
    await expect(attempt.run({ transport })).rejects.toThrow("interrupted");
    expect(attempt.canResume).toBe(true);
    const before = sent.length;
    expect(await attempt.run({ transport })).toEqual(f.receipt);
    expect(sent[before]?.path).toBe(`/api/v1/ingest/bundles/${f.identity.operation}`);
    expect(sent.filter((call) => call.path.endsWith("/prepare"))).toHaveLength(1);
    expect(sent.filter((call) => call.path.includes("/parts/"))).toHaveLength(f.bundle.files.length + (failure.startsWith("part-") ? 1 : 0));
    expect(sent.filter((call) => call.path.endsWith("/commit"))).toHaveLength(failure === "commit-before" ? 2 : 1);
    expect(attempt.canResume).toBe(false);
  });
  it("resends an uncertain prepare using the identical frozen request and key", async () => {
    const f = await fixture(); let first = true; const bodies: string[] = [];
    const transport: ImportTransport = async (path, init) => {
      if (path.endsWith("/prepare")) { bodies.push(String(init?.body)); if (first) { first = false; throw new Error("lost prepare"); } }
      return f.transport(path, init);
    };
    const attempt = createBrowserBundleImport(f.bundle, "fixed-key");
    await expect(attempt.run({ transport })).rejects.toThrow("lost prepare");
    // The caller's metadata object is not the continuation's authoritative input.
    (f.bundle.hashes as Record<string, string>)["ignored-new-key"] = "e".repeat(64);
    expect(await attempt.run({ transport })).toEqual(f.receipt);
    expect(bodies[1]).toBe(bodies[0]);
  });
  it("checks current session/generation/expiry before any resumed mutation", async () => {
    for (const fields of [{ staging_session_ref: "other" }, { expires_at: "2000-01-01T00:00:00Z" }]) {
      const f = await fixture(); const attempt = createBrowserBundleImport(f.bundle, "key");
      await expect(attempt.run({ transport: async (path, init) => {
        if (path.includes("/parts/")) throw new Error("stop"); return f.transport(path, init);
      } })).rejects.toThrow("stop");
      const calls: string[] = [];
      await expect(attempt.run({ transport: async (path) => { calls.push(path); return f.envelope({ ...f.status,
        receipt: undefined, state: "UPLOAD_REQUIRED", staging_session_ref: "session-1", ...fields }); } }))
        .rejects.toMatchObject({ code: "INGEST_RESPONSE_MISMATCH" });
      expect(calls).toHaveLength(1); expect(attempt.canResume).toBe(false);
    }
  });
  it("prevents concurrent continuation and clears state on explicit disposal", async () => {
    const f = await fixture(); let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const attempt = createBrowserBundleImport(f.bundle, "key");
    const running = attempt.run({ transport: async (path, init) => { await pause; return f.transport(path, init); } });
    const denied = expect(running).rejects.toMatchObject({ code: "BUNDLE_IMPORT_CANCELLED" });
    await expect(attempt.run()).rejects.toMatchObject({ code: "BUNDLE_IMPORT_NOT_RESUMABLE" });
    attempt.dispose(); release(); await denied;
    expect(attempt.canResume).toBe(false); expect(f.calls).toHaveLength(1);
    await expect(attempt.run()).rejects.toMatchObject({ code: "BUNDLE_IMPORT_NOT_RESUMABLE" });
  });
});
