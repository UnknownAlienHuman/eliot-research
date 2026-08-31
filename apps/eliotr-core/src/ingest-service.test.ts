import type {
  AuthenticatedRequestContext,
  OwnerApi,
  PrepareBundleUploadRequest,
} from "@eliotr/interfaces";
import type {
  IngestAdmissionAuthority,
  PreparedIngestOperation,
  StagedBundlePort,
} from "@eliotr/platform-cloudflare";
import { describe, expect, it, vi } from "vitest";
import { dispatchIngestOperation, IngestHttpInputError } from "./ingest-http.js";
import { createIngestService } from "./ingest-service.js";
import type { SourceAdmissionService } from "./source-admission-service.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const manifest: PrepareBundleUploadRequest["manifest"] = {
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
};
const files = { "content.md": A, "manifest.json": B, "hashes.sha256": C };
const context: AuthenticatedRequestContext = {
  request: new Request("https://research.example/api/v1/ingest/bundles/prepare"),
  principal_ref: "principal-1",
  client_class: "owner_pwa",
  credential_generation: "credential-v1",
  trace_id: "trace-1",
};

function operation(overrides: Partial<PreparedIngestOperation> = {}): PreparedIngestOperation {
  return {
    operation_id: "ingest-1",
    principal_ref: "principal-1",
    origin_authentication_receipt_ref: "credential-v1",
    idempotency_key: "idem-1",
    input_fingerprint: C,
    manifest_sha256: B,
    manifest,
    file_hashes: files,
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
    staging_session_ref: null,
    qualification_report_ref: null,
    decision_receipt_ref: null,
    promotion_receipt_ref: null,
    state: "PREPARING",
    bundle_receipt: null,
    created_at: "2026-08-31T00:00:00.000Z",
    updated_at: "2026-08-31T00:00:00.000Z",
    expires_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function fixture(initial = operation()) {
  let current = initial;
  const events: string[] = [];
  const finalReceipt = {
    operation_id: "ingest-1",
    manifest_sha256: B,
    source_revision_ref: "revision-1",
    object_residency_key_digest: B,
    decision: "REJECTED" as const,
    reason_codes: ["HASH_NOT_VERIFIED"],
    readback_sha256: A,
    committed_at: "2026-08-31T12:00:00.000Z",
  };
  const authority: IngestAdmissionAuthority = {
    async prepare() { events.push("authority.prepare"); return { disposition: "CREATED", operation: current }; },
    async bindStagingSession(_id, session) {
      events.push("authority.bind");
      current = { ...current, staging_session_ref: session, state: "UPLOAD_REQUIRED" };
      return current;
    },
    async load() { return current; },
    async loadForPrincipal() { return current; },
    async recordQualificationDecision(input) {
      events.push("authority.decision");
      current = {
        ...current,
        state: input.decision.decision === "ADMITTED" ? "AUTHORIZED" : input.decision.decision,
        decision_receipt_ref: input.decision.decision_receipt_ref,
        qualification_report_ref: `${input.qualification.report_ref.id}:1`,
      };
      return current;
    },
    async finalizeNonAdmitted(_id, receipt) { events.push("authority.finalize"); return receipt; },
    async authorizePromotion() { return true; },
    async commitAdmitted(input) { events.push("authority.commit"); return input.bundle_receipt; },
  };
  const staged: StagedBundlePort = {
    async prepare() {
      events.push("staging.prepare");
      return {
        disposition: "UPLOAD_REQUIRED",
        session: {
          session_id: "session-1",
          staging_prefix: "staging/session/session-1",
          part_size_bytes: 8 * 1024 * 1024,
          expires_at: "2026-09-01T00:00:00.000Z",
          uploads: [
            { path: "content.md", staging_key: "staging/content", upload_id: "upload-1", expected_sha256: A },
          ],
        },
        reason_codes: [],
      };
    },
    async uploadPart(input) {
      events.push("staging.upload");
      return { session_id: input.session_id, path: input.path, part_number: input.part_number, size_bytes: input.size_bytes, etag: "etag-1" };
    },
    async completeFile(sessionId, path) {
      events.push("staging.complete");
      return { protocol: "eliotr.staged-file-completion.v1", session_id: sessionId, path, sha256: A, size_bytes: 42, etag: "etag-1", completed_at: "2026-08-31T12:00:00.000Z" };
    },
    async verifyReadback() {
      events.push("staging.verify");
      return { verified: true, hashes: files, sizes: { "content.md": 20, "manifest.json": 12, "hashes.sha256": 10 }, total_bytes: 42, reason_codes: [] };
    },
    async promote(sessionId, decisionRef) {
      events.push("staging.promote");
      return {
        protocol: "eliotr.bundle-promotion.v1",
        session_id: sessionId,
        admission_receipt_ref: decisionRef,
        canonical_manifest_ref: "manifest-ref-1",
        readback_digest: A,
        promoted_objects: [
          { logical_path: "content.md", canonical_key: "normalized/content", sha256: A, size_bytes: 20, etag: "e1", existed_identically: false },
          { logical_path: "manifest.json", canonical_key: "normalized/manifest", sha256: B, size_bytes: 12, etag: "e2", existed_identically: false },
          { logical_path: "hashes.sha256", canonical_key: "normalized/hashes", sha256: C, size_bytes: 10, etag: "e3", existed_identically: false },
        ],
        promoted_at: "2026-08-31T12:00:00.000Z",
      };
    },
    async abort() {},
    async cleanupExpired() { return { scanned_sessions: 0, aborted_sessions: 0, cleaned_promoted_sessions: 0, resumed_aborted_sessions: 0, skipped_sessions: 0 }; },
  };
  const admission: SourceAdmissionService = {
    async evaluate() {
      events.push("admission.evaluate");
      return {
        qualification: {
          report_ref: { id: "qualification-1", revision: 1 },
          source_revision_ref: "revision-1",
          parser_profile_generation: "parser-1",
          checks: [{ check: "extraction_coverage", disposition: "PASS", reason_codes: [] }],
          overall: "QUALIFIED",
          exact_precision_ceiling: "line",
          warnings: [],
          created_at: "2026-08-31T12:00:00.000Z",
        },
        decision: {
          source_namespace_id: "namespace-1",
          owner_system_id: "owner-1",
          source_owner_generation: "owner-generation-1",
          source_revision_ref: "revision-1",
          origin_authentication_receipt_ref: "credential-v1",
          source_class: "document",
          assurance_ceiling: "QUALIFIED",
          instruction_taint: "DATA_ONLY",
          allowed_effects: "READ_ONLY",
          object_residency_key_digest: B,
          allowed_use: ["research"],
          disclosure_ceiling: "private",
          license_policy_ref: "license-1",
          decision: "ADMITTED",
          reason_codes: [],
          decision_receipt_ref: "decision-1",
        },
      };
    },
  };
  return { authority, staged, admission, events, finalReceipt, get current() { return current; } };
}

describe("governed ingest service", () => {
  it("creates D1 authority before exposing an R2 staging session", async () => {
    const f = fixture();
    const service = createIngestService({ authority: f.authority, stagedBundles: f.staged, admission: f.admission });
    const result = await service.prepareBundle(context, { manifest, file_hashes: files, total_bytes: 42, idempotency_key: "idem-1" });
    expect(f.events).toEqual(["authority.prepare", "staging.prepare", "authority.bind"]);
    expect(result).toMatchObject({ disposition: "UPLOAD_REQUIRED", multipart_session_ref: "session-1" });
  });

  it("rejects a foreign staging session before invoking R2", async () => {
    const f = fixture(operation({ staging_session_ref: "session-1", state: "UPLOAD_REQUIRED" }));
    const upload = vi.spyOn(f.staged, "uploadPart");
    const service = createIngestService({ authority: f.authority, stagedBundles: f.staged, admission: f.admission });
    await expect(service.uploadBundlePart(context, {
      operation_id: "ingest-1",
      multipart_session_ref: "session-2",
      path: "content.md",
      part_number: 1,
      size_bytes: 1,
      final_part: true,
      body: new Blob(["x"]).stream(),
    })).rejects.toMatchObject({ code: "INGEST_SESSION_MISMATCH" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("promotes only after an admitted decision and commits after promotion", async () => {
    const f = fixture(operation({ staging_session_ref: "session-1", state: "UPLOAD_REQUIRED" }));
    const service = createIngestService({ authority: f.authority, stagedBundles: f.staged, admission: f.admission });
    const result = await service.commitBundle(context, { operation_id: "ingest-1", multipart_session_ref: "session-1", manifest_sha256: B });
    expect(result.decision).toBe("ADMITTED");
    expect(f.events).toEqual(["staging.verify", "admission.evaluate", "authority.decision", "staging.promote", "authority.commit"]);
  });

  it("rejects unknown prepare fields before calling the owner API", async () => {
    const prepareBundle = vi.fn();
    const owner = { prepareBundle } as unknown as OwnerApi;
    const request = new Request("https://research.example/api/v1/ingest/bundles/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unknown: true }),
    });
    await expect(dispatchIngestOperation("ingest.bundle.prepare", request, new URL(request.url), {}, 262144, context, owner))
      .rejects.toBeInstanceOf(IngestHttpInputError);
    expect(prepareBundle).not.toHaveBeenCalled();
  });
});
