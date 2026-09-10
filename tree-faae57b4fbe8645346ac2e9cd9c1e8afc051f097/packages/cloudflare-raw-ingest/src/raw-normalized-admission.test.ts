import { describe, expect, it } from "vitest";
import { sha256Utf8 } from "@eliotr/platform-cloudflare";
import { createSnapshotViewWitness } from "./raw-normalized-snapshot-view.js";
import { prepareRawNormalizedAdmission } from "./raw-normalized-admission.js";
import { readRawNormalizedCandidate } from "./raw-normalized-candidate-reader.js";
import type { RawNormalizedCandidatePolicy, RawNormalizedCapture, RawNormalizedConversion, RawNormalizedOutputReadback } from "./raw-normalized-types.js";

const capture: RawNormalizedCapture = {
  capture_id: "raw-capture-1",
  principal_ref: "principal-1",
  owner_system_id: "owner-1",
  source_namespace_id: "namespace-1",
  source_revision_ref: "revision-1",
  source_logical_id: "source-1",
  source_owner_generation: "generation-1",
  original_file_name: "report.pdf",
  content_sha256: "a".repeat(64),
  size_bytes: 11,
  content_type: "application/pdf",
  residency_key_digest: "b".repeat(64),
};

const policy: RawNormalizedCandidatePolicy = {
  policy_snapshot_sha256: "c".repeat(64),
  policy_revision: 3,
  ownership_mode: "immutable_import",
  origin_location_class: "external",
  residency_and_disclosure: {
    scope_domain_id: "scope-1",
    access_domain_id: "access-1",
    confidentiality_domain_id: "private",
    encryption_key_domain_id: "key-1",
    retention_domain_id: "retention-1",
    erasure_domain_id: "erasure-1",
    disclosure_ceiling: "owner-only",
    allowed_use: ["research"],
  },
  analyzer: "workers-ai-markdown",
  analyzer_version: "profile-1",
  profile: "raw-markdown-v1",
  config_hash: "d".repeat(64),
  purpose: "library-import",
};

async function fixture() {
  const bytes = new TextEncoder().encode("# Converted report\n");
  const outputSha = await sha256Utf8(new TextDecoder().decode(bytes));
  const witness = await createSnapshotViewWitness({
    capture,
    policy_snapshot_sha256: policy.policy_snapshot_sha256,
    policy_revision: policy.policy_revision,
    observed_at: "2026-09-09T12:00:00.000Z",
    observation_freshness: "observed_with_age",
  });
  const conversion: RawNormalizedConversion = {
    protocol: "eliotr.raw-markdown-conversion.v1",
    state: "COMPLETE",
    operation_id: "conversion-1",
    capture_id: capture.capture_id,
    content_sha256: capture.content_sha256,
    output_sha256: outputSha,
    output_bytes: bytes.byteLength,
    detected_mime: "text/markdown",
    format: "markdown",
    tokens: 4,
  };
  const output: RawNormalizedOutputReadback = { object_key: "raw-markdown/conversion-1/output.md", bytes, sha256: outputSha, size_bytes: bytes.byteLength };
  return { bytes, witness, conversion, output };
}

describe("raw to normalized admission candidate", () => {
  it("builds an existing normalized-folder request from exact candidate readback", async () => {
    const f = await fixture();
    const prepared = await prepareRawNormalizedAdmission({ capture, conversion: f.conversion, output: f.output, snapshot_view: f.witness, policy }, "admission-1");
    expect(prepared.candidate.protocol).toBe("eliotr.raw-normalized-candidate.v1");
    expect(prepared.candidate.manifest.origin.source_view_ref).toMatch(/^snapshot-view:v1:[a-f0-9]{64}$/u);
    expect(prepared.candidate.manifest.quality).toMatchObject({ state: "degraded", assurance_ceiling: "CAPTURED" });
    expect(prepared.request.idempotency_key).toBe("admission-1");
    expect(prepared.request.file_hashes).toHaveProperty("content.md", f.output.sha256);
    expect(prepared.candidate.total_bytes).toBeGreaterThan(f.output.bytes.byteLength);
  });

  it("requires the witness even when a candidate has a source identity", async () => {
    const f = await fixture();
    await expect(readRawNormalizedCandidate({ capture, conversion: f.conversion, output: f.output, policy }))
      .rejects.toMatchObject({ code: "RAW_NORMALIZED_WITNESS_REQUIRED" });
  });

  it("rejects a missing or deleted witness rather than falling back to its ref", async () => {
    const f = await fixture();
    const deleted = { ...f.witness, source_view_ref: "snapshot-view:v1:" + "0".repeat(64) };
    await expect(readRawNormalizedCandidate({ capture, conversion: f.conversion, output: f.output, snapshot_view: deleted, policy }))
      .rejects.toMatchObject({ code: "RAW_NORMALIZED_WITNESS_REQUIRED" });
  });

  it("rejects forged output, changed policy and unknown load-bearing fields", async () => {
    const f = await fixture();
    await expect(readRawNormalizedCandidate({ capture, conversion: f.conversion, output: { ...f.output, bytes: new TextEncoder().encode("tampered"), size_bytes: 8 }, snapshot_view: f.witness, policy }))
      .rejects.toMatchObject({ code: "RAW_NORMALIZED_OUTPUT_MISMATCH" });
    await expect(readRawNormalizedCandidate({ capture, conversion: f.conversion, output: f.output, snapshot_view: f.witness, policy: { ...policy, policy_revision: 4 } }))
      .rejects.toMatchObject({ code: "RAW_NORMALIZED_WITNESS_REQUIRED" });
    await expect(readRawNormalizedCandidate({ capture: { ...capture, forged: true } as never, conversion: f.conversion, output: f.output, snapshot_view: f.witness, policy }))
      .rejects.toMatchObject({ code: "RAW_NORMALIZED_INVALID" });
  });

  it("rejects output over the server's 8 MiB bound", async () => {
    const f = await fixture();
    await expect(readRawNormalizedCandidate({ capture, conversion: { ...f.conversion, output_bytes: 8 * 1024 * 1024 + 1 }, output: f.output, snapshot_view: f.witness, policy }))
      .rejects.toMatchObject({ code: "RAW_NORMALIZED_INVALID" });
  });

  it("keeps observation historical and degrades precision without maps", async () => {
    const f = await fixture();
    const candidate = await readRawNormalizedCandidate({ capture, conversion: f.conversion, output: f.output, snapshot_view: f.witness, policy });
    expect(candidate.snapshot_view.observation_freshness).toBe("observed_with_age");
    expect(candidate.manifest.capabilities).toEqual({ text_ranges: true, pages: false, bounding_boxes: false, tables: false, figures: false });
    expect(candidate.manifest.content.mappings).toBeUndefined();
    expect(candidate.manifest.quality.state).toBe("degraded");
  });
});
