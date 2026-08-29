import { describe, expect, it } from "vitest";
import { createR2StagedBundlePort } from "./ingest.js";
import {
  bundleFixture,
  bytesStream,
  fakeBucket,
  testDigestSink,
  uploadAll,
} from "./ingest-test-fixture.js";

describe("R2 normalized bundle staging", () => {
  it("stages, verifies, and promotes each file under its own complete residency digest", async () => {
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
      idempotency_key: "bundle-a",
    });
    expect(prepared.disposition).toBe("UPLOAD_REQUIRED");
    const session = prepared.session;
    if (session === undefined) throw new Error("prepare did not return a session");
    await uploadAll(port, session, fixture.files);
    expect(await port.verifyReadback(session.session_id)).toEqual(expect.objectContaining({
      verified: true,
      reason_codes: [],
      total_bytes: fixture.totalBytes,
    }));
    expect(evidence.objects.size).toBe(0);
    const promoted = await port.promote(session.session_id, "admission-receipt-a");
    expect(promoted.promoted_objects).toHaveLength(3);
    const residencyDigests = new Set(promoted.promoted_objects.map((entry) => entry.canonical_key.split("/")[1]));
    expect(residencyDigests.size).toBe(3);
    expect(await port.promote(session.session_id, "admission-receipt-a")).toEqual(promoted);
  });

  it("binds an idempotency identity to exactly one bundle fingerprint", async () => {
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
    const input = {
      manifest: fixture.manifest,
      residency_key: fixture.residency,
      file_hashes: fixture.hashes,
      total_bytes: fixture.totalBytes,
      idempotency_scope: "principal-a",
      idempotency_key: "bundle-a",
    } as const;
    await port.prepare(input);
    await expect(port.prepare({ ...input, total_bytes: input.total_bytes + 1 }))
      .rejects.toMatchObject({ code: "STAGING_SESSION_CONFLICT" });
  });

  it("does not trust a caller-declared multipart size", async () => {
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
      idempotency_key: "bundle-size-mismatch",
    });
    const session = prepared.session;
    if (session === undefined) throw new Error("prepare did not return a session");
    const body = fixture.files["content.md"];
    if (body === undefined) throw new Error("fixture content.md is missing");
    await expect(port.uploadPart({
      session_id: session.session_id,
      path: "content.md",
      part_number: 1,
      size_bytes: body.byteLength + 1,
      final_part: true,
      body: bytesStream(body),
    })).rejects.toMatchObject({ code: "STAGING_PART_INVALID" });
  });

  it("tombstones and cleans an expired staging session idempotently", async () => {
    const work = fakeBucket();
    const evidence = fakeBucket();
    const fixture = await bundleFixture();
    let currentTime = Date.parse("2026-08-29T00:00:00Z");
    const port = createR2StagedBundlePort({
      work_bucket: work.binding,
      evidence_bucket: evidence.binding,
      create_sha256_sink: testDigestSink,
      authorize_promotion: async () => true,
      session_ttl_ms: 60_000,
      now: () => currentTime,
    });
    const input = {
      manifest: fixture.manifest,
      residency_key: fixture.residency,
      file_hashes: fixture.hashes,
      total_bytes: fixture.totalBytes,
      idempotency_scope: "principal-a",
      idempotency_key: "bundle-expired",
    } as const;
    const prepared = await port.prepare(input);
    expect(prepared.session).not.toBe(undefined);
    currentTime += 120_000;
    expect(await port.cleanupExpired(10)).toEqual({
      scanned_sessions: 1,
      aborted_sessions: 1,
      cleaned_promoted_sessions: 0,
      resumed_aborted_sessions: 0,
      skipped_sessions: 0,
    });
    expect((await port.prepare(input)).disposition).toBe("REJECTED");
  });

  it("does not treat a self-consistent but false hashes document as verified", async () => {
    const work = fakeBucket();
    const evidence = fakeBucket();
    const fixture = await bundleFixture(`${"f".repeat(64)}  content.md\n`);
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
      idempotency_key: "bundle-corrupt-hashes",
    });
    const session = prepared.session;
    if (session === undefined) throw new Error("prepare did not return a session");
    await uploadAll(port, session, fixture.files);
    const verification = await port.verifyReadback(session.session_id);
    expect(verification.verified).toBe(false);
    expect(verification.reason_codes).toContain("HASHES_DOCUMENT_MISMATCH");
    await expect(port.promote(session.session_id, "admission-receipt-a"))
      .rejects.toMatchObject({ code: "PROMOTION_INTEGRITY_FAILURE" });
  });
});
