import { describe, expect, it } from "vitest";
import { prepareBrowserBundle } from "../apps/eliotr-pwa/src/bundle-input.js";
import { recoverBrowserBundleImport } from "../apps/eliotr-pwa/src/bundle-import.js";
import { type ImportTransport } from "../apps/eliotr-pwa/src/bundle-import-api.js";
import { bundleFixture } from "../packages/platform-cloudflare/src/ingest-test-fixture.js";
import { canonicalDigest } from "../packages/platform-cloudflare/src/d1-ingest-validation.js";

async function fixture() {
  const f = await bundleFixture();
  const bundle = await prepareBrowserBundle(Object.entries(f.files).map(([path, bytes]) => ({ path, blob: new Blob([new Uint8Array(bytes)]) })));
  const digest = await canonicalDigest(bundle.manifest); const expiry = new Date(Date.now() + 600000).toISOString();
  const status = { operation_id: "ingest-recover", state: "UPLOAD_REQUIRED", staging_session_ref: "session-recover",
    source_revision_ref: bundle.manifest.origin.source_revision_ref, expires_at: expiry, updated_at: new Date().toISOString() };
  const data = { protocol: "eliotr.ingest-recovery.v1", status, idempotency_key: "original-key", manifest_sha256: digest,
    total_bytes: bundle.totalBytes, file_hashes: bundle.hashes };
  const envelope = (body: unknown, generation = "current-generation") => ({ data: body, trace_id: "trace-recover", deployment_generation: generation });
  return { bundle, status, data, envelope };
}

describe("operation-bound browser recovery", () => {
  it("performs only a fixed same-origin GET until the user explicitly continues", async () => {
    const f = await fixture(); const calls: string[] = [];
    const attempt = await recoverBrowserBundleImport(f.bundle, "ingest-recover", { transport: async (path, init) => {
      expect(init?.method).toBeUndefined(); calls.push(path); return f.envelope(f.data);
    } });
    expect(calls).toEqual(["/api/v1/ingest/bundles/ingest-recover/recovery"]);
    expect(attempt.canResume).toBe(true); attempt.dispose(); expect(attempt.canResume).toBe(false);
  });
  it("rejects mismatched hashes or byte count before any mutation", async () => {
    const f = await fixture();
    for (const changed of [{ ...f.data, total_bytes: f.bundle.totalBytes + 1 },
      { ...f.data, file_hashes: { ...f.bundle.hashes, "content.md": "a".repeat(64) } }]) {
      let calls = 0;
      await expect(recoverBrowserBundleImport(f.bundle, "ingest-recover", { transport: async (_path, init) => {
        expect(init?.method).toBeUndefined(); ++calls; return f.envelope(changed);
      } })).rejects.toMatchObject({ code: "BUNDLE_RECOVERY_FILES_CHANGED" });
      expect(calls).toBe(1);
    }
  });
  it("rejects unknown metadata, foreign operation, missing files and expired reservations", async () => {
    const f = await fixture();
    for (const changed of [{ ...f.data, credentials: "forbidden" }, { ...f.data, protocol: "future" },
      { ...f.data, status: { ...f.status, operation_id: "foreign" } },
      { ...f.data, file_hashes: { "content.md": f.bundle.hashes["content.md"] } },
      { ...f.data, status: { ...f.status, expires_at: "2000-01-01T00:00:00Z" } }]) {
      await expect(recoverBrowserBundleImport(f.bundle, "ingest-recover", { transport: async () => f.envelope(changed) })).rejects.toThrow();
    }
  });
  it("rechecks the current generation before issuing the repeated prepare", async () => {
    const f = await fixture(); const attempt = await recoverBrowserBundleImport(f.bundle, "ingest-recover", {
      transport: async () => f.envelope(f.data) });
    const calls: string[] = [];
    await expect(attempt.run({ transport: async (path, init) => {
      expect(init?.method).toBeUndefined(); calls.push(path); return f.envelope(f.status, "another-generation");
    } })).rejects.toMatchObject({ code: "INGEST_RESPONSE_MISMATCH" });
    expect(calls).toHaveLength(1); expect(attempt.canResume).toBe(false);
  });
  it("never silently falls back to a new import on missing or denied recovery", async () => {
    const f = await fixture();
    for (const code of [401, 403, 404]) {
      let calls = 0; const transport: ImportTransport = async () => { ++calls; throw new Error(`denied-${code}`); };
      await expect(recoverBrowserBundleImport(f.bundle, "ingest-recover", { transport })).rejects.toThrow(`denied-${code}`);
      expect(calls).toBe(1);
    }
  });
  it("cancels before recovery transport and snapshots inputs before waiting on server state", async () => {
    const f = await fixture();
    await expect(recoverBrowserBundleImport(f.bundle, "ingest-recover", { signal: AbortSignal.abort(),
      transport: async () => { throw new Error("must not request"); } })).rejects.toMatchObject({ code: "BUNDLE_IMPORT_CANCELLED" });
    const attempt = await recoverBrowserBundleImport(f.bundle, "ingest-recover", { transport: async () => {
      const reply = structuredClone(f.data);
      (f.bundle.hashes as Record<string, string>)["content.md"] = "e".repeat(64);
      return f.envelope(reply);
    } });
    expect(attempt.canResume).toBe(true); attempt.dispose();
  });
});
