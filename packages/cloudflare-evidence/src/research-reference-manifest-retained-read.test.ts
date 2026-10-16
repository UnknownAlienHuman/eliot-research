import { describe, expect, it, vi } from "vitest";
import type { AllowedReferenceManifest, ObjectResidencyKey } from "@eliotr/contracts";
import { canonicalEvidenceObjectKey, objectResidencyKeyDigest } from "@eliotr/platform-cloudflare";
import { canonicalEvidenceJson, evidenceSha256, evidenceSha256Bytes } from "./canonical.js";
import type { NavigationReadAuthority } from "./navigation-storage-authority.js";
import { createResearchReferenceManifestReader, createResearchReferenceManifestStore,
  type PostModelReadbackManifestContext, type ReferenceManifestStorageContext } from "./research-reference-manifest-store.js";

const now = "2026-10-16T18:23:31.973Z";
const liveUntil = "2026-10-17T18:17:35.776Z";
const expiredAt = "2026-10-16T18:23:29.418Z";

async function fixture() {
  const material = {
    manifest_ref: { id: "manifest-1", revision: 1 }, scope_snapshot_ref: { id: "scope-1", revision: 1 },
    allowed_source_revision_refs: ["revision-1"], allowed_evidence_handle_refs: [{ id: "handle-1", revision: 1 }],
    allowed_tool_definition_refs: [], allowed_verifier_refs: [], permitted_anchor_and_precision_ceilings: [],
    provider_and_policy_generations: { policy: "policy-1" }, stale_or_revoked_entries: [],
    permitted_acquisition_or_expansion_routes: [], disclosure_ceiling: "owner-only", allowed_use: ["research"],
    expires_at: expiredAt, client_fence_ref: "credential-1",
  };
  const manifest: AllowedReferenceManifest = { ...material, manifest_digest: await evidenceSha256(material) };
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(manifest));
  const contentDigest = await evidenceSha256Bytes(bytes);
  const residency: ObjectResidencyKey = {
    scope_domain_id: "scope-1", access_domain_id: "owner-1", confidentiality_domain_id: "confidential-1",
    encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
    content_digest: { algorithm: "sha256", digest: contentDigest },
  };
  const context: ReferenceManifestStorageContext = {
    principal_ref: "owner-1", credential_generation: "credential-1", scope_snapshot_ref: material.scope_snapshot_ref,
    manifest_residency_key: residency, policy_authority_ref: "policy-1", authorization_receipt_ref: "grant-1",
    scope_snapshot_digest: "a".repeat(64), pack_ref: { id: "pack-1", revision: 1 }, trace_ref: { id: "trace-1", revision: 1 },
    stage_attempt_ref: "attempt-five", stage_request_sha256: "b".repeat(64), created_at: "2026-10-16T18:18:36.000Z",
  };
  const row = {
    manifest_id: "manifest-1", manifest_revision: 1, manifest_digest: manifest.manifest_digest,
    r2_content_sha256: contentDigest, r2_residency_key_json: canonicalEvidenceJson(residency),
    r2_residency_key_digest: await objectResidencyKeyDigest(residency),
    r2_key: await canonicalEvidenceObjectKey(residency, "research/reference-manifest", contentDigest),
    r2_etag: "etag-1", r2_size_bytes: bytes.byteLength, scope_snapshot_id: "scope-1", scope_snapshot_revision: 1,
    scope_snapshot_digest: context.scope_snapshot_digest, policy_authority_ref: "policy-1", authorization_receipt_ref: "grant-1",
    principal_ref: "owner-1", credential_generation: "credential-1", pack_ref_id: "pack-1", pack_ref_revision: 1,
    trace_ref_id: "trace-1", trace_ref_revision: 1, stage_attempt_ref: "attempt-five", stage_request_sha256: "b".repeat(64),
    state: "COMMITTED", created_at: context.created_at, expires_at: expiredAt,
  };
  const grant = { allowed_use: ["research"], disclosure_ceiling: "owner-only", expires_at: liveUntil,
    policy_authority_ref: "policy-1", authorization_receipt_ref: "grant-1" };
  const source = { source_revision_ref: "revision-1", source_owner_generation: "owner-generation-1", purge_state: "LIVE",
    object_residency_key_digest: "c".repeat(64), admission_expires_at: liveUntil };
  const navigation = {
    access: { principal_ref: "owner-1", credential_generation: "credential-1" },
    scope: { snapshot_id: "scope-1", revision: 1, digest: context.scope_snapshot_digest,
      member_source_revision_refs: ["revision-1"], expires_at: liveUntil },
    current: vi.fn(async () => structuredClone(grant)), sources: vi.fn(async () => [structuredClone(source)]), timestamp: () => now,
  };
  const object = { etag: row.r2_etag, size: bytes.byteLength, httpMetadata: { contentType: "application/json" },
    customMetadata: { eliotr_sha256: contentDigest, eliotr_size_bytes: String(bytes.byteLength), eliotr_immutable: "true" },
    arrayBuffer: async () => bytes.slice().buffer };
  const get = vi.fn(async () => object);
  const put = vi.fn();
  const first = vi.fn(async () => row);
  const run = vi.fn();
  const database = { prepare: () => ({ bind: () => ({ first, run }) }) } as unknown as D1Database;
  const bucket = { get, put } as unknown as R2Bucket;
  const dependencies = { database, work_bucket: bucket, navigation: navigation as unknown as NavigationReadAuthority };
  const retained: PostModelReadbackManifestContext = {
    purpose: "POST_MODEL_READBACK", stage: "RESOLVE_CITATIONS", operation_id: "operation-1", investigation_id: "investigation-1",
    principal_ref: "owner-1", credential_generation: "credential-1", scope_snapshot_ref: material.scope_snapshot_ref,
    stage_five_attempt_ref: "attempt-five", stage_five_request_sha256: "b".repeat(64),
    committed_model_stages: (["SYNTHESIZE", "VERIFY", "AUDIT_CLAIMS"] as const).map((stage, index) => ({
      stage, operation_id: "operation-1", investigation_id: "investigation-1", attempt_ref: `attempt-${index + 12}`,
      request_sha256: String(index + 1).repeat(64), receipt_ref: `receipt-${index + 12}`,
    })),
  };
  return { manifest, bytes, row, grant, source, navigation, object, get, put, run, retained,
    reader: createResearchReferenceManifestReader(dependencies), store: createResearchReferenceManifestStore({ ...dependencies, context }) };
}

describe("retained post-model manifest readback", () => {
  it.each(["RESOLVE_CITATIONS", "CALCULATE_COVERAGE", "MATERIALIZE"] as const)("returns unchanged expired bytes only for %s readback", async (stage) => {
    const f = await fixture();
    await expect(f.reader.get(f.manifest.manifest_ref)).rejects.toMatchObject({ code: "REFERENCE_MANIFEST_SCOPE_STALE" });
    const found = await f.reader.getForPostModelReadback(f.manifest.manifest_ref, { ...f.retained, stage });
    expect(canonicalEvidenceJson(found)).toBe(new TextDecoder().decode(f.bytes));
    expect(found?.expires_at).toBe(expiredAt);
    await expect(f.store.get(f.manifest.manifest_ref)).rejects.toMatchObject({ code: "REFERENCE_MANIFEST_SCOPE_STALE" });
    await expect(f.store.persist(f.manifest)).rejects.toMatchObject({ code: "REFERENCE_MANIFEST_SCOPE_STALE" });
    await expect(f.store.readReceipt(f.manifest.manifest_ref)).rejects.toMatchObject({ code: "REFERENCE_MANIFEST_SCOPE_STALE" });
    expect(f.put).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(["purpose", "stage", "missing-audit", "operation", "stage-five", "principal"])("rejects invalid retained proof: %s", async (fault) => {
    const f = await fixture();
    const proof = { ...f.retained };
    if (fault === "purpose") Object.assign(proof, { purpose: "MODEL_PROMPT" });
    if (fault === "stage") Object.assign(proof, { stage: "AUDIT_CLAIMS" });
    if (fault === "missing-audit") Object.assign(proof, { committed_model_stages: proof.committed_model_stages.slice(0, 2) });
    if (fault === "operation") Object.assign(proof, { operation_id: "operation-foreign" });
    if (fault === "stage-five") Object.assign(proof, { stage_five_request_sha256: "d".repeat(64) });
    if (fault === "principal") Object.assign(proof, { principal_ref: "foreign-owner" });
    await expect(f.store.getForPostModelReadback(f.manifest.manifest_ref, proof)).rejects.toMatchObject({ code: "REFERENCE_MANIFEST_INPUT_INVALID" });
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each(["scope", "grant", "disclosure", "allowed-use", "revoked", "changed-grant", "changed-owner", "changed-residency", "purged"])("keeps current authority fences: %s", async (fault) => {
    const f = await fixture();
    if (fault === "scope") f.navigation.scope.expires_at = expiredAt;
    if (fault === "grant") f.grant.expires_at = expiredAt;
    if (fault === "disclosure") f.grant.disclosure_ceiling = "public";
    if (fault === "allowed-use") f.grant.allowed_use = [];
    if (fault === "revoked") f.navigation.current.mockRejectedValue(Object.assign(new Error("revoked"), { code: "NAVIGATION_SCOPE_NOT_CURRENT" }));
    f.get.mockImplementation(async () => {
      if (fault === "changed-grant") f.grant.authorization_receipt_ref = "revoked-grant";
      if (fault === "changed-owner") f.source.source_owner_generation = "owner-generation-2";
      if (fault === "changed-residency") f.source.object_residency_key_digest = "d".repeat(64);
      if (fault === "purged") f.navigation.sources.mockRejectedValue(Object.assign(new Error("purged"), { code: "NAVIGATION_SCOPE_NOT_CURRENT" }));
      return f.object;
    });
    await expect(f.store.getForPostModelReadback(f.manifest.manifest_ref, f.retained)).rejects.toMatchObject({ code: "REFERENCE_MANIFEST_SCOPE_STALE" });
    expect(f.put).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(["bytes", "etag", "residency"])("preserves immutable readback checks: %s", async (fault) => {
    const f = await fixture();
    if (fault === "bytes") f.object.arrayBuffer = async () => new Uint8Array(f.bytes.byteLength).buffer;
    if (fault === "etag") f.object.etag = "changed-etag";
    if (fault === "residency") f.row.r2_residency_key_digest = "e".repeat(64);
    await expect(f.store.getForPostModelReadback(f.manifest.manifest_ref, f.retained)).rejects.toMatchObject({
      code: fault === "residency" ? "REFERENCE_MANIFEST_INPUT_INVALID" : "REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN",
    });
  });
});
