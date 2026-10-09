import type { PrepareBundleUploadRequest } from "@eliotr/interfaces";
import type {
  IngestAdmissionAuthority,
  PreparedIngestOperation,
  StagedBundlePort,
} from "@eliotr/platform-cloudflare";
import { describe, expect, it, vi } from "vitest";
import {
  createIngestWorkflowOwnerService,
  type IngestWorkflowOwnerServiceInput,
} from "./ingest-workflow-owner-service.js";

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
const request: PrepareBundleUploadRequest = {
  idempotency_key: "workflow-ingest-1",
  manifest,
  file_hashes: files,
  total_bytes: 42,
};

function operation(): PreparedIngestOperation {
  return {
    operation_id: "ingest-1",
    principal_ref: "principal-1",
    origin_authentication_receipt_ref: "credential-1",
    idempotency_key: request.idempotency_key,
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
  };
}

function testAuthority(
  prepare: IngestAdmissionAuthority["prepare"],
): IngestAdmissionAuthority {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected ingest authority operation");
  };
  return {
    prepare,
    bindStagingSession: unexpected,
    load: unexpected,
    loadForPrincipal: unexpected,
    loadBySourceRevisionForPrincipal: unexpected,
    recordQualificationDecision: unexpected,
    finalizeNonAdmitted: unexpected,
    authorizePromotion: unexpected,
    commitAdmitted: unexpected,
  };
}

function testStaging(prepare: StagedBundlePort["prepare"]): StagedBundlePort {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected staged bundle operation");
  };
  return {
    prepare,
    uploadPart: unexpected,
    completeFile: unexpected,
    verifyReadback: unexpected,
    promote: unexpected,
    abort: unexpected,
    cleanupExpired: unexpected,
  };
}

function ownerInput(
  read_current_authority: IngestWorkflowOwnerServiceInput["read_current_authority"],
) {
  const authorityPrepare = vi.fn(async () => ({
    disposition: "CREATED" as const,
    operation: operation(),
  }));
  const stagedPrepare = vi.fn(async () => {
    throw new Error("R2 staging must not be reached in this regression");
  });
  const authority = testAuthority(authorityPrepare);
  const staged = testStaging(stagedPrepare);
  const input: IngestWorkflowOwnerServiceInput = {
    operation_id: "workflow-operation-1",
    principal: {
      principal_ref: "principal-1",
      credential_generation: "credential-1",
      deployment_generation: "deployment-1",
    },
    read_current_authority,
    dependencies: {
      authority,
      create_staged_bundles: () => staged,
      authorize_promotion: async () => false,
      admission: {
        async evaluate() {
          throw new Error("source admission must not be reached in this regression");
        },
      },
    },
  };
  return { input, authorityPrepare, stagedPrepare };
}

describe("Workflow-owned ingest bundle port", () => {
  it("denies service actors before effects and detects post-effect authority drift", async () => {
    const deniedReads: Array<{ operationId: string; principal: object }> = [];
    const denied = ownerInput(async (operationId, principal) => {
      deniedReads.push({ operationId, principal });
      return {
        principal_ref: "principal-1",
        client_class: "trusted_agent",
        credential_generation: "credential-1",
        workflow_state: "ACTIVE",
      };
    });
    const deniedPort = createIngestWorkflowOwnerService(denied.input);

    await expect(deniedPort.prepareBundle(request)).rejects.toMatchObject({
      code: "INGEST_PRINCIPAL_DENIED",
    });
    expect(deniedReads).toEqual([{
      operationId: "workflow-operation-1",
      principal: {
        principal_ref: "principal-1",
        credential_generation: "credential-1",
        deployment_generation: "deployment-1",
      },
    }]);
    expect(denied.authorityPrepare).not.toHaveBeenCalled();
    expect(denied.stagedPrepare).not.toHaveBeenCalled();

    const driftReads: Array<{ operationId: string; principal: object }> = [];
    let readCount = 0;
    const drift = ownerInput(async (operationId, principal) => {
      driftReads.push({ operationId, principal });
      readCount += 1;
      return {
        principal_ref: "principal-1",
        client_class: "owner_pwa",
        credential_generation: "credential-1",
        workflow_state: readCount === 3 ? "COMPLETED" : "ACTIVE",
      };
    });
    const driftPort = createIngestWorkflowOwnerService(drift.input);

    await expect(driftPort.prepareBundle(request)).rejects.toMatchObject({
      code: "INGEST_PRINCIPAL_DENIED",
    });
    expect(drift.authorityPrepare).toHaveBeenCalledTimes(1);
    expect(drift.authorityPrepare).toHaveBeenCalledWith(expect.objectContaining({
      principal_ref: "principal-1",
      origin_authentication_receipt_ref: "credential-1",
    }));
    expect(drift.stagedPrepare).not.toHaveBeenCalled();
    expect(driftReads).toHaveLength(3);
    expect(driftReads).toEqual(Array.from({ length: 3 }, () => ({
      operationId: "workflow-operation-1",
      principal: {
        principal_ref: "principal-1",
        credential_generation: "credential-1",
        deployment_generation: "deployment-1",
      },
    })));
  });
});
