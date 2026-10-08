import type { ArtifactRevision, ArtifactSpec, EvidenceFreeze, ObjectResidencyKey, VersionedRef } from "@eliotr/contracts";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import type { ArtifactDraftReferencedObjectInput, PrepareArtifactDraftInput, PrepareArtifactDraftResult } from "./artifact-draft.js";
import { ArtifactCowError, type ArtifactCowParent, type ArtifactCowPorts, type ArtifactCowSectionObject } from "./artifact-cow.js";
const createdAt = "2026-09-30T12:00:00.000Z";
const artifactRef = { id: "artifact-one", revision: 1 } satisfies VersionedRef;
const firstBody = new TextEncoder().encode("Original introduction.");
const secondBody = new TextEncoder().encode("Original findings.");

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function residency(bytes: Uint8Array): Promise<ObjectResidencyKey> {
  return {
    scope_domain_id: "scope-one",
    access_domain_id: "access-one",
    confidentiality_domain_id: "confidential",
    encryption_key_domain_id: "key-one",
    retention_domain_id: "retention-one",
    erasure_domain_id: "erasure-one",
    content_digest: { algorithm: "sha256", digest: await sha256(bytes) },
  };
}

function referenceObject(
  object_ref: string,
  object_kind: ArtifactDraftReferencedObjectInput["object_kind"],
  body: string,
): Promise<ArtifactDraftReferencedObjectInput> {
  const bytes = new TextEncoder().encode(body);
  return residency(bytes).then((objectResidency) => ({ object_ref, object_kind, bytes, residency: objectResidency }));
}

export async function artifactCowFixture(): Promise<{ parent: ArtifactCowParent; ports: ArtifactCowPorts; prepared: PrepareArtifactDraftInput[] }> {
  const spec: ArtifactSpec = {
    spec_ref: { id: "spec-one", revision: 1 }, kind: "research_report", title: "Report",
    scope_snapshot_ref: { id: "scope-one", revision: 1 }, inquiry_protocol_ref: { id: "protocol-one", revision: 1 },
    audience: "researchers", language: "en", citation_policy_ref: "citations-v1", verification_policy_ref: "verification-v1",
    include_counterevidence: true, include_methodology: true, length_policy_ref: "length-v1", export_formats: ["markdown"], budget_ref: "budget-one",
    section_contracts: [
      { section_id: "introduction", title: "Introduction", purpose: "Frame the question", required_claim_kinds: ["observation"], required_evidence_classes: ["source"], maximum_utf8_bytes: 4096 },
      { section_id: "findings", title: "Findings", purpose: "Report results", required_claim_kinds: ["observation"], required_evidence_classes: ["source"], maximum_utf8_bytes: 4096 },
    ],
  };
  const freeze: EvidenceFreeze = {
    freeze_ref: { id: "freeze-one", revision: 1 }, scope_snapshot_ref: spec.scope_snapshot_ref,
    coverage_denominator_ref: { id: "denominator-one", revision: 1 },
    contract_protocol_digest: "a".repeat(64), lane_digest: "b".repeat(64), included_evidence: [], excluded_evidence: [],
    unresolved_contradiction_refs: [], open_research_debt_refs: [], provider_model_prompt_tool_generations: {}, frozen_at: createdAt,
  };
  const sectionOne: ArtifactCowSectionObject = {
    section: {
      section_ref: { id: "section-intro", revision: 1 }, contract_id: "introduction", body_object_ref: "body-intro-v1",
      body_sha256: await sha256(firstBody), statement_labels: {}, evidence_ledger_ref: "evidence-intro-v1", verification_receipt_ref: "verify-intro-v1",
    }, bytes: new Uint8Array(firstBody), residency: await residency(firstBody),
  };
  const sectionTwo: ArtifactCowSectionObject = {
    section: {
      section_ref: { id: "section-findings", revision: 1 }, contract_id: "findings", body_object_ref: "body-findings-v1",
      body_sha256: await sha256(secondBody), statement_labels: {}, evidence_ledger_ref: "evidence-findings-v1", verification_receipt_ref: "verify-findings-v1",
    }, bytes: new Uint8Array(secondBody), residency: await residency(secondBody),
  };
  const revision: ArtifactRevision = {
    artifact_ref: artifactRef, spec_ref: spec.spec_ref, spec_digest: await canonicalDigest(spec), evidence_freeze_ref: freeze.freeze_ref,
    sections: [sectionOne.section, sectionTwo.section], dependency_manifest_ref: "dependencies-v1",
    deterministic_export_refs: { markdown: "report-v1" }, status: "DRAFT", created_at: createdAt,
  };
  const parent: ArtifactCowParent = {
    spec, freeze, revision, sections: [sectionOne, sectionTwo], manifest_residency: await residency(new TextEncoder().encode("parent-manifest")),
    referenced_objects: [
      await referenceObject("dependencies-v1", "DEPENDENCY_MANIFEST", "dependency manifest v1"),
      await referenceObject("evidence-intro-v1", "EVIDENCE_LEDGER", "intro evidence v1"),
      await referenceObject("verify-intro-v1", "VERIFICATION_RECEIPT", "intro verification v1"),
      await referenceObject("evidence-findings-v1", "EVIDENCE_LEDGER", "findings evidence v1"),
      await referenceObject("verify-findings-v1", "VERIFICATION_RECEIPT", "findings verification v1"),
      await referenceObject("report-v1", "EXPORT", "report v1"),
    ],
  };
  const nextBody = new TextEncoder().encode("Updated introduction, checked against the current evidence freeze.");
  const changed: ArtifactCowSectionObject = {
    section: {
      section_ref: { id: "section-intro", revision: 2 }, contract_id: "introduction", body_object_ref: "body-intro-v2",
      body_sha256: await sha256(nextBody), statement_labels: {}, evidence_ledger_ref: "evidence-intro-v2", verification_receipt_ref: "verify-intro-v2",
    }, bytes: nextBody, residency: await residency(nextBody),
  };
  const generatedObjects = [
    await referenceObject("dependencies-v2", "DEPENDENCY_MANIFEST", "dependency manifest v2"),
    await referenceObject("evidence-intro-v2", "EVIDENCE_LEDGER", "intro evidence v2"),
    await referenceObject("verify-intro-v2", "VERIFICATION_RECEIPT", "intro verification v2"),
  ];
  const exportedObject = await referenceObject("report-v2", "EXPORT", "# Report\n\nUpdated introduction.\n\nOriginal findings.");
  let head = 1;
  const prepared: PrepareArtifactDraftInput[] = [];
  const ports: ArtifactCowPorts = {
    compile: async () => revision,
    readExactParent: async (ref) => ref.id === artifactRef.id && ref.revision === 1 ? parent : null,
    validateParentSection: async () => undefined,
    loadSectionEvidencePack: async () => ({
      pack_ref: { id: "evidence-pack-one", revision: 1 },
      scope_snapshot_ref: spec.scope_snapshot_ref,
      resolved_evidence: [],
      omitted_candidates: [],
      trace_ref: { id: "retrieval-trace-one", revision: 1 },
      total_utf8_bytes: 0,
    }),
    compileSection: async () => ({ ...changed, referenced_objects: generatedObjects, dependency_manifest_ref: "dependencies-v2" }),
    validateCompiledSection: async () => undefined,
    assembleExports: async () => ({ refs: { markdown: "report-v2" }, objects: [exportedObject] }),
    createIntent: async () => ({
      intent: { intent_ref: { id: "intent-revise", revision: 1 }, operation_kind: "REPORT", principal_ref: "owner-one", idempotency_key: "revise-one", payload_ref: "artifact-one", policy_decision_ref: "allow-one", created_at: createdAt },
      created_at: createdAt,
    }),
    createResidency: async ({ template, bytes }) => ({ ...template, content_digest: { algorithm: "sha256", digest: await sha256(bytes) } }),
    prepare: async (input) => {
      if (input.expected_draft_head_revision !== head) throw new ArtifactCowError("ARTIFACT_COW_HEAD_STALE", "draft head CAS lost");
      prepared.push(input);
      head = input.revision.artifact_ref.revision;
      return {
        disposition: "CREATED", artifact_ref: input.revision.artifact_ref, intent_ref: input.intent.intent_ref,
        outbox_id: "outbox-one", draft_head_revision: head,
        manifest: { object_ref: "manifest", object_kind: "MANIFEST", section_ordinal: null, residency: input.manifest_residency, receipt: { key: "manifest-key", expected_sha256: input.revision.spec_digest, readback_sha256: input.revision.spec_digest, size_bytes: 1, etag: "etag", existed_identically: false } },
        objects: [],
      } satisfies PrepareArtifactDraftResult;
    },
  };
  return { parent, ports, prepared };
}
