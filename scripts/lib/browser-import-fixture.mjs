import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Controlled browser-only backend. Real namespace/ingest/policy/storage is tested in Workers/D1/R2.
export function browserImportFixture() {
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const content = "# Browser fixture\n\nРусский и English source.\n";
  const hash = sha(content); const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 3600000).toISOString();
  const manifest = { protocol: "eliotr.normalized.v1", origin: { owner_system_id: "fixture-owner",
    source_namespace_id: "browser-namespace", source_owner_generation: "owner-1", source_revision_ref: "browser-revision",
    source_view_ref: "browser-view", ownership_mode: "immutable_import" }, source: { logical_id: "browser-source",
    original_name: "browser.md", original_sha256: hash, origin_location_class: "external", mime_type: "text/markdown" },
    residency_and_disclosure: { scope_domain_id: "scope-1", access_domain_id: "access-1", confidentiality_domain_id: "private",
      encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
      disclosure_ceiling: "owner-only", allowed_use: ["research"] }, normalization: { analyzer: "browser-fixture",
      analyzer_version: "1", profile: "standard", config_hash: "1".repeat(64), created_at: now },
    content: { markdown: "content.md", markdown_sha256: hash }, capabilities: { text_ranges: true,
      pages: false, bounding_boxes: false, tables: false, figures: false },
    quality: { state: "standard", assurance_ceiling: "QUALIFIED", warnings: [] }, export: { purpose: "test", receipt_ref: "test-export" } };
  const text = JSON.stringify(manifest);
  const files = { "content.md": content, "manifest.json": text, "hashes.sha256": `${hash}  content.md\n${sha(text)}  manifest.json\n` };
  const hashes = Object.fromEntries(Object.entries(files).map(([path, body]) => [path, sha(body)]));
  const calls = []; let lost = false; let committed = false; let key;
  const operation = "ingest-browser"; const session = "session-browser";
  const receipt = { operation_id: operation, manifest_sha256: "d".repeat(64), source_revision_ref: "browser-revision",
    normalized_artifact_ref: "browser-artifact", object_residency_key_digest: "a".repeat(64), decision: "ADMITTED", reason_codes: [],
    readback_sha256: "b".repeat(64), committed_at: now };
  const envelope = (data) => ({ data, trace_id: "browser-trace", deployment_generation: "browser-fixture" });
  const handle = async (request, response, url) => {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; assert.ok(size < 64 * 1024); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    calls.push({ path: url.pathname, method: request.method });
    response.setHeader("content-type", "application/json"); response.setHeader("cache-control", "no-store");
    const json = (value) => response.end(JSON.stringify(envelope(value)));
    if (url.pathname.endsWith("/prepare")) {
      const body = JSON.parse(bytes.toString("utf8"));
      assert.deepEqual(body.manifest, manifest); assert.deepEqual(body.file_hashes, hashes);
      key ??= body.idempotency_key; assert.equal(body.idempotency_key, key);
      return json({ operation_id: operation, manifest_sha256: receipt.manifest_sha256, disposition: "UPLOAD_REQUIRED",
        multipart_session_ref: session, files: Object.keys(files).map((path) => ({ path, expected_sha256: hashes[path], max_part_bytes: 8 * 1024 * 1024 })),
        expires_at: expiry, reason_codes: [] });
    }
    if (url.pathname.includes("/parts/")) {
      const path = url.searchParams.get("path"); assert.equal(bytes.toString("utf8"), files[path]);
      return json({ operation_id: operation, multipart_session_ref: session, path, part_number: 1, size_bytes: bytes.length, etag: `part-${path}` });
    }
    if (url.pathname.endsWith("/files/complete")) {
      const body = JSON.parse(bytes.toString("utf8"));
      if (!lost) { lost = true; response.statusCode = 503;
        response.end(JSON.stringify({ status: 503, code: "TEST_COMPLETION_ACK_LOST", message: "Controlled completion acknowledgement loss", trace_id: "browser-trace" })); return; }
      return json({ operation_id: operation, multipart_session_ref: session, path: body.path,
        sha256: hashes[body.path], size_bytes: Buffer.byteLength(files[body.path]), etag: `complete-${body.path}`, completed_at: now });
    }
    if (url.pathname.endsWith("/commit")) { committed = true; return json(receipt); }
    if (url.pathname === `/api/v1/ingest/bundles/${operation}/recovery` || url.pathname === "/api/v1/ingest/bundles/discover") {
      assert.equal(request.method, url.pathname.endsWith("/discover") ? "POST" : "GET"); assert.ok(key);
      if (url.pathname.endsWith("/discover")) {
        assert.deepEqual(JSON.parse(bytes.toString("utf8")), { manifest, file_hashes: hashes,
          total_bytes: Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0) });
      }
      return json({ protocol: "eliotr.ingest-recovery.v1", idempotency_key: key,
        manifest_sha256: receipt.manifest_sha256, file_hashes: hashes,
        total_bytes: Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
        status: { operation_id: operation, source_revision_ref: "browser-revision", state: committed ? "COMMITTED" : "UPLOAD_REQUIRED",
          staging_session_ref: session, expires_at: expiry, updated_at: now, ...(committed ? { receipt } : {}) } });
    }
    assert.equal(url.pathname, `/api/v1/ingest/bundles/${operation}`);
    return json({ operation_id: operation, source_revision_ref: "browser-revision", state: committed ? "COMMITTED" : "UPLOAD_REQUIRED",
      staging_session_ref: session, expires_at: expiry, updated_at: now, ...(committed ? { receipt } : {}) });
  };
  return { files, calls, handle };
}
