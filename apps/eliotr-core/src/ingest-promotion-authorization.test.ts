import type {
  BundlePromotionAuthorization,
  IngestAdmissionAuthority,
  PreparedIngestOperation,
} from "@eliotr/platform-cloudflare";
import { describe, expect, it, vi } from "vitest";
import {
  authorizeIngestPromotion,
  stagedBundleInputFingerprint,
} from "./ingest-promotion-authorization.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function operation(): PreparedIngestOperation {
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
      "hashes.sha256": C,
      "content.md": A,
      "manifest.json": B,
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
    qualification_report_ref: "qualification-1:1",
    decision_receipt_ref: "decision-1",
    promotion_receipt_ref: null,
    state: "AUTHORIZED",
    bundle_receipt: null,
    created_at: "2026-08-31T00:00:00.000Z",
    updated_at: "2026-08-31T00:00:00.000Z",
    expires_at: "2026-09-01T00:00:00.000Z",
  };
}

function database(ownerRevision: unknown = 1): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        bind() { return statement; },
        async first<T>() {
          if (sql.includes("FROM bundle_ingest_operation")) return { operation_id: "ingest-1" } as T;
          if (sql.includes("FROM source_namespace_ownership")) {
            return ownerRevision === null ? null : { source_admission_policy_revision: ownerRevision } as T;
          }
          return null;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function authority(current: PreparedIngestOperation) {
  const authorizePromotion = vi.fn(async () => true);
  const value: IngestAdmissionAuthority = {
    async prepare() { throw new Error("unused"); },
    async bindStagingSession() { throw new Error("unused"); },
    async load() { return current; },
    async loadForPrincipal() { return current; },
    async loadBySourceRevisionForPrincipal() { return current; },
    async recordQualificationDecision() { throw new Error("unused"); },
    async finalizeNonAdmitted() { throw new Error("unused"); },
    authorizePromotion,
    async commitAdmitted() { throw new Error("unused"); },
  };
  return { value, authorizePromotion };
}

function authorization(inputFingerprint: string): BundlePromotionAuthorization {
  return {
    session_id: "session-1",
    input_fingerprint: inputFingerprint,
    residency_key_digest: B,
    owner_system_id: "owner-1",
    source_namespace_id: "namespace-1",
    source_owner_generation: "owner-generation-1",
    source_revision_ref: "revision-1",
  };
}

describe("ingest promotion authorization", () => {
  it("accepts the exact R2 bundle fingerprint and translates it to the D1 authority fingerprint", async () => {
    const current = operation();
    const fixture = authority(current);
    const r2Fingerprint = await stagedBundleInputFingerprint(current);
    expect(r2Fingerprint).not.toBe(current.input_fingerprint);
    await expect(authorizeIngestPromotion(
      database(),
      fixture.value,
      authorization(r2Fingerprint),
      "decision-1",
    )).resolves.toBe(true);
    expect(fixture.authorizePromotion).toHaveBeenCalledWith(
      expect.objectContaining({ input_fingerprint: current.input_fingerprint }),
      "decision-1",
    );
  });

  it("rejects the D1 authority fingerprint when it is supplied as an R2 staging fingerprint", async () => {
    const current = operation();
    const fixture = authority(current);
    await expect(authorizeIngestPromotion(
      database(),
      fixture.value,
      authorization(current.input_fingerprint),
      "decision-1",
    )).resolves.toBe(false);
    expect(fixture.authorizePromotion).not.toHaveBeenCalled();
  });

  it("fails closed when the owner generation or policy revision is no longer active", async () => {
    const current = operation();
    const fixture = authority(current);
    await expect(authorizeIngestPromotion(
      database(2),
      fixture.value,
      authorization(await stagedBundleInputFingerprint(current)),
      "decision-1",
    )).rejects.toMatchObject({ code: "INGEST_OWNER_NOT_ACTIVE" });
    expect(fixture.authorizePromotion).not.toHaveBeenCalled();
  });
});
