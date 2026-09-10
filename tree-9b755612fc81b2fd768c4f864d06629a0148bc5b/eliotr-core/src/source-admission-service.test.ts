import type { PreparedIngestOperation, StagedBundleVerification } from "@eliotr/platform-cloudflare";
import { describe, expect, it } from "vitest";
import { createSourceAdmissionService } from "./source-admission-service.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);

function operation(overrides: Partial<PreparedIngestOperation> = {}): PreparedIngestOperation {
  return {
    operation_id: "ingest-1",
    principal_ref: "principal-1",
    origin_authentication_receipt_ref: "credential-v1",
    idempotency_key: "idem-1",
    input_fingerprint: C,
    manifest_sha256: B,
    manifest: {
      protocol: "eliotr.normalized.v1",
      origin: {
        owner_system_id: "owner-1",
        source_namespace_id: "namespace-1",
        source_owner_generation: "owner-generation-1",
        source_revision_ref: "revision-1",
        source_view_ref: "view-1",
        ownership_mode: "immutable_import",
      },
      source: {
        logical_id: "source-1",
        original_name: "source.md",
        original_sha256: A,
        origin_location_class: "external",
        mime_type: "text/markdown",
      },
      residency_and_disclosure: {
        scope_domain_id: "scope-1",
        access_domain_id: "access-1",
        confidentiality_domain_id: "private",
        encryption_key_domain_id: "key-1",
        retention_domain_id: "retention-1",
        erasure_domain_id: "erasure-1",
        disclosure_ceiling: "private",
        allowed_use: ["research"],
      },
      normalization: {
        analyzer: "fixture",
        analyzer_version: "1.0.0",
        profile: "markdown",
        config_hash: C,
        created_at: "2026-08-31T12:00:00.000Z",
      },
      content: { markdown: "content.md", markdown_sha256: A },
      capabilities: {
        text_ranges: true,
        pages: false,
        bounding_boxes: false,
        tables: false,
        figures: false,
      },
      quality: { state: "standard", assurance_ceiling: "QUALIFIED", warnings: [] },
      export: { purpose: "research", receipt_ref: "export-1" },
    },
    file_hashes: {
      "content.md": A,
      "manifest.json": B,
      "hashes.sha256": C,
    },
    total_bytes: 42,
    source_namespace_id: "namespace-1",
    owner_system_id: "owner-1",
    source_owner_generation: "owner-generation-1",
    source_revision_ref: "revision-1",
    source_id: "source-1",
    expected_head_revision_ref: null,
    residency_key: {
      scope_domain_id: "scope-1",
      access_domain_id: "access-1",
      confidentiality_domain_id: "private",
      encryption_key_domain_id: "key-1",
      retention_domain_id: "retention-1",
      erasure_domain_id: "erasure-1",
      content_digest: { algorithm: "sha256", digest: A },
    },
    residency_key_digest: B,
    policy: {
      source_namespace_id: "namespace-1",
      revision: 1,
      authorized_principal_refs: ["principal-1"],
      allowed_ownership_modes: ["immutable_import"],
      source_class: "document",
      assurance_ceiling: "QUALIFIED",
      instruction_taint: "DATA_ONLY",
      allowed_effects: "READ_ONLY",
      allowed_use: ["research"],
      disclosure_ceiling: "private",
      license_policy_ref: "license-1",
      default_storage_policy: "storage-1",
      default_residency_profile_id: "residency-1",
      default_retention_policy_id: "retention-1",
      minimum_quality_state: "standard",
      created_at: "2026-08-31T00:00:00.000Z",
    },
    policy_snapshot_sha256: C,
    candidate_id: "candidate-1",
    staging_session_ref: "session-1",
    qualification_report_ref: null,
    decision_receipt_ref: null,
    promotion_receipt_ref: null,
    state: "UPLOAD_REQUIRED",
    bundle_receipt: null,
    created_at: "2026-08-31T00:00:00.000Z",
    updated_at: "2026-08-31T00:00:00.000Z",
    expires_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function verification(overrides: Partial<StagedBundleVerification> = {}): StagedBundleVerification {
  return {
    verified: true,
    hashes: { "content.md": A, "manifest.json": B, "hashes.sha256": C },
    sizes: { "content.md": 20, "manifest.json": 12, "hashes.sha256": 10 },
    total_bytes: 42,
    reason_codes: [],
    ...overrides,
  };
}

describe("source admission composition", () => {
  const service = createSourceAdmissionService({ now: () => NOW });

  it("admits an exact qualified captured bundle under the policy ceiling", async () => {
    const result = await service.evaluate(operation(), verification());
    expect(result.qualification.overall).toBe("QUALIFIED");
    expect(result.decision).toMatchObject({ decision: "ADMITTED", assurance_ceiling: "QUALIFIED" });
  });

  it("lowers unsupported page precision instead of inventing mappings", async () => {
    const base = operation();
    const result = await service.evaluate({
      ...base,
      manifest: {
        ...base.manifest,
        capabilities: { ...base.manifest.capabilities, pages: true },
      },
    }, verification());
    expect(result.qualification.overall).toBe("DEGRADED");
    expect(result.qualification.exact_precision_ceiling).toBe("line");
    expect(result.qualification.checks).toContainEqual(expect.objectContaining({
      check: "source_mapping_completeness",
      disposition: "DEGRADED",
    }));
  });

  it("rejects a verification whose exact hash set differs from prepare authority", async () => {
    const result = await service.evaluate(operation(), verification({
      hashes: { "content.md": A, "manifest.json": B, "hashes.sha256": "9".repeat(64) },
    }));
    expect(result.decision.decision).toBe("REJECTED");
    expect(result.decision.reason_codes).toContain("HASH_NOT_VERIFIED");
  });

  it("quarantines a bundle below the policy quality floor", async () => {
    const base = operation();
    const result = await service.evaluate({
      ...base,
      manifest: { ...base.manifest, quality: { ...base.manifest.quality, state: "degraded" } },
    }, verification());
    expect(result.decision.decision).toBe("QUARANTINED");
    expect(result.decision.reason_codes).toContain("QUALITY_BELOW_POLICY_MINIMUM");
  });
});
