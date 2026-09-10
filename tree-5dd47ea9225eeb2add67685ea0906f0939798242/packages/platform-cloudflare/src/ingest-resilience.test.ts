import { describe, expect, it } from "vitest";
import { createR2StagedBundlePort } from "./ingest.js";
import {
  bundleFixture,
  fakeBucket,
  testDigestSink,
  uploadAll,
} from "./ingest-test-fixture.js";

describe("R2 normalized bundle staging resilience", () => {
  it("recovers prepare after a lost acknowledgement without creating a second authority record", async () => {
    const work = fakeBucket({ throw_after_put_prefix: "staging/session/" });
    const evidence = fakeBucket();
    const fixture = await bundleFixture();
    const port = createR2StagedBundlePort({
      work_bucket: work.binding,
      evidence_bucket: evidence.binding,
      create_sha256_sink: testDigestSink,
      authorize_promotion: async () => true,
      now: () => Date.parse("2026-08-29T00:00:00Z"),
    });
    const input = {
      manifest: fixture.manifest,
      residency_key: fixture.residency,
      file_hashes: fixture.hashes,
      total_bytes: fixture.totalBytes,
      idempotency_scope: "principal-a",
      idempotency_key: "bundle-lost-ack",
    } as const;
    const prepared = await port.prepare(input);
    expect(prepared.reason_codes).toEqual(["READBACK_RECOVERED"]);
    const resumed = await port.prepare(input);
    expect(resumed.reason_codes).toEqual(["RESUMED"]);
    expect(resumed.session?.session_id).toBe(prepared.session?.session_id);
  });

  it("requires admission authority before writing any canonical evidence object", async () => {
    const work = fakeBucket();
    const evidence = fakeBucket();
    const fixture = await bundleFixture();
    const port = createR2StagedBundlePort({
      work_bucket: work.binding,
      evidence_bucket: evidence.binding,
      create_sha256_sink: testDigestSink,
      authorize_promotion: async () => false,
      now: () => Date.parse("2026-08-29T00:00:00Z"),
    });
    const prepared = await port.prepare({
      manifest: fixture.manifest,
      residency_key: fixture.residency,
      file_hashes: fixture.hashes,
      total_bytes: fixture.totalBytes,
      idempotency_scope: "principal-a",
      idempotency_key: "bundle-denied",
    });
    const session = prepared.session;
    if (session === undefined) throw new Error("prepare did not return a session");
    await uploadAll(port, session, fixture.files);
    await expect(port.promote(session.session_id, "admission-receipt-denied"))
      .rejects.toMatchObject({ code: "PROMOTION_NOT_AUTHORIZED" });
    expect(evidence.objects.size).toBe(0);
  });

  it("rejects staged bytes whose authoritative multipart metadata changes after prepare", async () => {
    const work = fakeBucket();
    const evidence = fakeBucket();
    const fixture = await bundleFixture();
    const port = createR2StagedBundlePort({
      work_bucket: work.binding,
      evidence_bucket: evidence.binding,
      create_sha256_sink: testDigestSink,
      authorize_promotion: async () => true,
      now: () => Date.parse("2026-08-29T00:00:00Z"),
    });
    const prepared = await port.prepare({
      manifest: fixture.manifest,
      residency_key: fixture.residency,
      file_hashes: fixture.hashes,
      total_bytes: fixture.totalBytes,
      idempotency_scope: "principal-a",
      idempotency_key: "bundle-metadata-tamper",
    });
    const session = prepared.session;
    if (session === undefined) throw new Error("prepare did not return a session");
    await uploadAll(port, session, fixture.files);
    const contentUpload = session.uploads.find((upload) => upload.path === "content.md");
    if (contentUpload === undefined) throw new Error("content upload missing");
    const stored = work.objects.get(contentUpload.staging_key);
    if (stored === undefined) throw new Error("staged object missing");
    stored.customMetadata.eliotr_expected_sha256 = "f".repeat(64);
    const verification = await port.verifyReadback(session.session_id);
    expect(verification.verified).toBe(false);
    expect(verification.reason_codes).toContain("FILE_READBACK_FAILED:content.md");
    await expect(port.promote(session.session_id, "admission-receipt-a"))
      .rejects.toMatchObject({ code: "PROMOTION_INTEGRITY_FAILURE" });
    expect(evidence.objects.size).toBe(0);
  });

  it("cleans promoted staging bytes without deleting the terminal promotion receipt", async () => {
    const work = fakeBucket();
    const evidence = fakeBucket();
    const fixture = await bundleFixture();
    const port = createR2StagedBundlePort({
      work_bucket: work.binding,
      evidence_bucket: evidence.binding,
      create_sha256_sink: testDigestSink,
      authorize_promotion: async () => true,
      now: () => Date.parse("2026-08-29T00:00:00Z"),
    });
    const prepared = await port.prepare({
      manifest: fixture.manifest,
      residency_key: fixture.residency,
      file_hashes: fixture.hashes,
      total_bytes: fixture.totalBytes,
      idempotency_scope: "principal-a",
      idempotency_key: "bundle-promoted-cleanup",
    });
    const session = prepared.session;
    if (session === undefined) throw new Error("prepare did not return a session");
    await uploadAll(port, session, fixture.files);
    const promoted = await port.promote(session.session_id, "admission-receipt-a");
    expect(await port.cleanupExpired(10)).toEqual({
      scanned_sessions: 1,
      aborted_sessions: 0,
      cleaned_promoted_sessions: 1,
      resumed_aborted_sessions: 0,
      skipped_sessions: 0,
    });
    expect(await port.promote(session.session_id, "admission-receipt-a")).toEqual(promoted);
  });
});
