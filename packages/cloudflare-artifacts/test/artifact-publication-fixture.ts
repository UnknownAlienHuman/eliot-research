import type { ArtifactRevision, ArtifactSpec, ObjectResidencyKey, VersionedRef } from "@eliotr/contracts";
import { canonicalDigest, canonicalJson } from "@eliotr/platform-cloudflare";
import { createNavigationReadAuthority, type EvidenceAccessContext } from "@eliotr/cloudflare-evidence";
import { createD1ScopeService, createOwnerScopeAuthority } from "../../cloudflare-navigation/src/index.js";
import {
  createArtifactDraftStore,
  encodeArtifactDraftVerificationV2,
  type PrepareArtifactDraftInput,
} from "../src/index.js";
import {
  committedEvidenceFreezeFixture,
  principal as freezePrincipal,
} from "../../../apps/eliotr-core/test/research-evidence-freeze-fixture.js";

export type ArtifactPublicationFreezeFixture = Awaited<ReturnType<typeof committedEvidenceFreezeFixture>>;

export type ArtifactPublicationPreparedDraft = Awaited<ReturnType<typeof prepareArtifactPublicationDraft>>;

const sha = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((buffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));

async function residency(scopeId: string, principal: string, digest: string): Promise<ObjectResidencyKey> {
  return {
    scope_domain_id: scopeId,
    access_domain_id: principal,
    confidentiality_domain_id: "owner-private",
    encryption_key_domain_id: "publication-test-key",
    retention_domain_id: "publication-test-retention",
    erasure_domain_id: "publication-test-erasure",
    content_digest: { algorithm: "sha256", digest },
  };
}

/**
 * Builds a controlled, local V2 verification receipt over the freeze fixture's
 * real evidence. It uses no live provider or external verification service.
 */
export async function prepareArtifactPublicationDraft(fixture: ArtifactPublicationFreezeFixture) {
  const stageFive = await fixture.readers.read_stage_five({
    operation_id: fixture.operation_id,
    investigation_id: fixture.investigation_id,
    principal: freezePrincipal,
  });
  const evidence = stageFive.evidence_pack.resolved_evidence[0];
  if (evidence === undefined) throw new Error("freeze fixture has no resolved evidence");
  const access = { ...freezePrincipal, client_class: "owner_pwa" as const };
  const authorization = await fixture.navigation.current();
  const artifactRef = { id: `publication-${crypto.randomUUID()}`, revision: 1 } satisfies VersionedRef;
  const dependencyRef = { id: `dependency-${crypto.randomUUID()}`, revision: 1 } satisfies VersionedRef;
  const freezeRef = { id: `freeze-${crypto.randomUUID()}`, revision: 1 } satisfies VersionedRef;
  const sectionRef = { id: `section-${crypto.randomUUID()}`, revision: 1 } satisfies VersionedRef;
  const claimRef = { id: `claim-${crypto.randomUUID()}`, revision: 1 } satisfies VersionedRef;
  const body = evidence.exact_excerpt;
  const bodyBytes = new TextEncoder().encode(body);
  const bodySha = await sha(body);
  const outputSha = "d".repeat(64);
  const claimText = "The cited source supports the stated observation.";
  const claimTextSha = await sha(claimText);
  const manifestDigest = "c".repeat(64);
  const allowedManifest = {
    manifest_ref: dependencyRef,
    scope_snapshot_ref: { id: fixture.scope.snapshot_id, revision: fixture.scope.revision },
    allowed_source_revision_refs: [evidence.handle.source_revision_ref],
    allowed_evidence_handle_refs: [evidence.handle.handle_ref],
    allowed_tool_definition_refs: [],
    allowed_verifier_refs: ["fixture-verifier-v1"],
    permitted_anchor_and_precision_ceilings: ["normalized-text-coordinates-v1"],
    provider_and_policy_generations: { policy: "publication-test-policy-v1" },
    stale_or_revoked_entries: [],
    permitted_acquisition_or_expansion_routes: [],
    disclosure_ceiling: "owner-only",
    allowed_use: ["research"],
    expires_at: fixture.scope.expires_at,
    manifest_digest: manifestDigest,
  };
  const dependencyBytes = new TextEncoder().encode(canonicalJson(allowedManifest));
  const draftSection = {
    section_ref: sectionRef,
    contract_id: "findings",
    body_object_ref: `body-${sectionRef.id}`,
    body_sha256: bodySha,
    statement_labels: { [claimRef.id]: "SOURCE_SUPPORTED" as const },
    evidence_ledger_ref: `ledger-${sectionRef.id}`,
    verification_receipt_ref: `verification-pending-${sectionRef.id}`,
  };
  const spec: ArtifactSpec = {
    spec_ref: { id: `spec-${artifactRef.id}`, revision: 1 },
    kind: "research_report",
    title: "Publication integration report",
    scope_snapshot_ref: { id: fixture.scope.snapshot_id, revision: fixture.scope.revision },
    inquiry_protocol_ref: { id: "publication-test-protocol", revision: 1 },
    audience: "researchers",
    language: "en",
    citation_policy_ref: "publication-citation-policy-v1",
    verification_policy_ref: "publication-verification-policy-v1",
    include_counterevidence: false,
    include_methodology: false,
    length_policy_ref: "publication-length-policy-v1",
    export_formats: ["markdown"],
    budget_ref: "publication-test-budget",
    section_contracts: [{ section_id: "findings", title: "Findings", purpose: "State a supported observation",
      required_claim_kinds: ["observation"], required_evidence_classes: ["source"], maximum_utf8_bytes: 32768 }],
  };
  const verification = await encodeArtifactDraftVerificationV2({
    schema: "eliotr.research.draft-verification.v2",
    semantic_verification: "EXECUTED",
    source_readback: "AUTHORITATIVE_RESOLVED",
    operation_id: `publication-operation-${artifactRef.id}`,
    investigation_ref: { id: "publication-investigation", revision: 1 },
    output_sha256: outputSha,
    freeze_ref: freezeRef,
    freeze_sha256: "a".repeat(64),
    manifest_ref: dependencyRef,
    manifest_sha256: manifestDigest,
    evidence_pack_ref: { id: "publication-evidence-pack", revision: 1 },
    trace_ref: { id: "publication-trace", revision: 1 },
    cited_evidence: [{
      handle_ref: evidence.handle.handle_ref,
      excerpt_sha256: evidence.handle.excerpt_sha256,
      source_revision_content_sha256: "b".repeat(64),
      scope_snapshot_digest: fixture.scope.digest,
      authorization_receipt_ref: authorization.authorization_receipt_ref,
      credential_generation: access.credential_generation,
    }],
    section_sha256: bodySha,
    audit: {
      stage_attempt_ref: `audit-attempt-${artifactRef.id}`,
      stage_request_sha256: "e".repeat(64),
      output_sha256: "f".repeat(64),
      synthesis_output_sha256: outputSha,
      normalization_binding_sha256: "1".repeat(64),
      verifier_ref: "fixture-verifier-v1",
      verifier_schema_generation: "fixture-verifier-schema-v1",
      model_receipt_ref: "fixture-model-receipt-v1",
      claims: [{ claim_ref: claimRef, claim_text: claimText, claim_text_digest: claimTextSha,
        disposition: "SUPPORTED", support_handle_refs: [evidence.handle.handle_ref], counterevidence_handle_refs: [] }],
    },
  });
  const section = { ...draftSection, verification_receipt_ref: verification.verification_receipt_ref };
  const createdAt = new Date().toISOString();
  const revision: ArtifactRevision = {
    artifact_ref: artifactRef,
    spec_ref: spec.spec_ref,
    spec_digest: await canonicalDigest(spec),
    evidence_freeze_ref: freezeRef,
    sections: [section],
    dependency_manifest_ref: `${dependencyRef.id}:${dependencyRef.revision}`,
    deterministic_export_refs: { markdown: `export-${artifactRef.id}` },
    status: "DRAFT",
    created_at: createdAt,
  };
  const manifestBytes = new TextEncoder().encode(canonicalJson({ spec, revision }));
  const draftStore = createArtifactDraftStore(fixture.db, fixture.bucket);
  const markdownExportRef = revision.deterministic_export_refs.markdown;
  if (markdownExportRef === undefined) throw new Error("verified publication fixture is missing its markdown export");
  const draftInput: PrepareArtifactDraftInput = {
    intent: {
      intent_ref: { id: `draft-intent-${artifactRef.id}`, revision: 1 },
      operation_kind: "REPORT",
      principal_ref: access.principal_ref,
      idempotency_key: `draft-${artifactRef.id}`,
      payload_ref: artifactRef.id,
      policy_decision_ref: "publication-test-draft-authority",
      created_at: createdAt,
    },
    expected_draft_head_revision: null,
    spec,
    revision,
    sections: [{ section, bytes: bodyBytes, residency: await residency(fixture.scope.snapshot_id, access.principal_ref, bodySha) }],
    referenced_objects: [
      { object_ref: revision.dependency_manifest_ref, object_kind: "DEPENDENCY_MANIFEST", bytes: dependencyBytes,
        residency: await residency(fixture.scope.snapshot_id, access.principal_ref, await sha(new TextDecoder().decode(dependencyBytes))) },
      { object_ref: section.evidence_ledger_ref, object_kind: "EVIDENCE_LEDGER", bytes: new TextEncoder().encode("owner evidence ledger"),
        residency: await residency(fixture.scope.snapshot_id, access.principal_ref, await sha("owner evidence ledger")) },
      { object_ref: section.verification_receipt_ref, object_kind: "VERIFICATION_RECEIPT", bytes: verification.bytes,
        residency: await residency(fixture.scope.snapshot_id, access.principal_ref, verification.sha256) },
      { object_ref: markdownExportRef, object_kind: "EXPORT", bytes: bodyBytes,
        residency: await residency(fixture.scope.snapshot_id, access.principal_ref, bodySha) },
    ],
    manifest_residency: await residency(fixture.scope.snapshot_id, access.principal_ref, await sha(new TextDecoder().decode(manifestBytes))),
  };
  await draftStore.prepare(draftInput);
  return { fixture, access, authorization, artifactRef, revision, evidence, draftInput };
}

export async function createArtifactPublicationFixture() {
  const fixture = await committedEvidenceFreezeFixture();
  const prepared = await prepareArtifactPublicationDraft(fixture);
  return { fixture, prepared };
}

export async function prepareNextArtifactPublicationDraftRevision(prepared: ArtifactPublicationPreparedDraft) {
  const ref = { id: prepared.artifactRef.id, revision: prepared.artifactRef.revision + 1 } satisfies VersionedRef;
  const createdAt = new Date().toISOString();
  const revision: ArtifactRevision = {
    ...prepared.draftInput.revision,
    artifact_ref: ref,
    sections: prepared.draftInput.revision.sections.map((section) => ({
      ...section,
      section_ref: { id: section.section_ref.id, revision: section.section_ref.revision + 1 },
      reused_from_revision_ref: prepared.artifactRef,
    })),
    created_at: createdAt,
  };
  const manifestBytes = new TextEncoder().encode(canonicalJson({ spec: prepared.draftInput.spec, revision }));
  const draftInput: PrepareArtifactDraftInput = {
    ...prepared.draftInput,
    intent: {
      intent_ref: { id: `draft-intent-${ref.id}-r${ref.revision}`, revision: 1 },
      operation_kind: "REPORT",
      principal_ref: prepared.access.principal_ref,
      idempotency_key: `draft-${ref.id}-r${ref.revision}`,
      payload_ref: ref.id,
      policy_decision_ref: "publication-test-draft-authority",
      created_at: createdAt,
    },
    expected_draft_head_revision: prepared.artifactRef.revision,
    revision,
    sections: revision.sections.map((section, index) => {
      const original = prepared.draftInput.sections[index];
      if (original === undefined) throw new Error("COW predecessor section is missing");
      return { ...original, section };
    }),
    manifest_residency: await residency(prepared.fixture.scope.snapshot_id, prepared.access.principal_ref,
      await sha(new TextDecoder().decode(manifestBytes))),
  };
  await createArtifactDraftStore(prepared.fixture.db, prepared.fixture.bucket).prepare(draftInput);
  return { ...prepared, artifactRef: ref, revision, draftInput };
}

export async function createArtifactPublicationFreshNavigation(
  fixture: ArtifactPublicationFreezeFixture,
  access: Pick<EvidenceAccessContext, "principal_ref" | "client_class" | "credential_generation">,
  sourceNamespaceId: string,
  nowMs = Date.now(),
) {
  const source = await fixture.db.prepare("SELECT source_id FROM source WHERE source_namespace_id=?1 LIMIT 1")
    .bind(sourceNamespaceId).first<{ readonly source_id: string }>();
  if (source === null) throw new Error("freeze source disappeared");
  const owner = createOwnerScopeAuthority(fixture.db, access, () => nowMs);
  const scopes = createD1ScopeService(fixture.db, owner, { now: () => nowMs, ttl_ms: 3_600_000 });
  const scope = await scopes.freeze({ kind: "SELECTED_SOURCES", source_ids: [source.source_id] }, access.credential_generation);
  await owner.grant(scope);
  const navigation = createNavigationReadAuthority({ database: fixture.db, scope_snapshot: scope, access,
    require_current: (requested) => scopes.requireCurrent(requested), now: () => nowMs });
  return { navigation, require_current: (requested: Parameters<typeof scopes.requireCurrent>[0]) => scopes.requireCurrent(requested) };
}
