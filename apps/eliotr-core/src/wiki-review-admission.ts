import {
  ArtifactRevisionSchema,
  CoverageReceiptSchema,
  VersionedRefSchema,
  type ArtifactRevision,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import {
  readHistoricalResearchCoverage,
} from "@eliotr/cloudflare-research-stages";
import {
  WikiPublicationError,
  type WikiPublicationErrorCode,
} from "@eliotr/research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import {
  MAX_BODY_BYTES,
  MAX_EVIDENCE_MAP_BYTES,
  MAX_MANIFEST_BYTES,
  decodeProposal,
  decodeWikiOwnerReviewReceipt,
  loadProposalRow,
  loadAuthority,
  readObject,
  recordWikiPublicationAuthority,
  sha256,
  validRef,
  type WikiOwnerReviewReceipt,
} from "./wiki-publication-store-support.js";
import {
  readDependencyManifest,
  readSection,
  requireFreshOwnerScope,
  type SectionRead,
  GENERATOR,
} from "./wiki-proposal-from-research-run.js";
import { reopenOwnerArtifactDraft } from "./research-artifact-reauthorization-http.js";

const FROM_RUN_PROTOCOL = "eliotr.wiki-proposal-from-research-run.v1";
const EVIDENCE_MAP_PROTOCOL = "eliotr.wiki-evidence-map.v1";
const RECEIPT_PROTOCOL = "eliotr.wiki.owner-review.v1";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;

export interface WikiOwnerReviewAdmissionResult {
  readonly protocol: typeof RECEIPT_PROTOCOL;
  readonly proposal_ref: VersionedRef;
  readonly review_receipt_ref: string;
  readonly coverage_complete: boolean;
  readonly supported_claim_count: number;
}

interface ParsedEvidenceMap {
  readonly protocol: typeof EVIDENCE_MAP_PROTOCOL;
  readonly operation_id: string;
  readonly artifact_ref: VersionedRef;
  readonly artifact: ArtifactRevision;
  readonly coverage_receipt_ref: VersionedRef;
  readonly coverage_receipt: ReturnType<typeof CoverageReceiptSchema.parse>;
  readonly provenance: Record<string, unknown>;
  readonly dependency_manifest: Record<string, unknown>;
  readonly sections: readonly Record<string, unknown>[];
}

function fail(code: WikiPublicationErrorCode, message: string, retryable = false): never {
  throw new WikiPublicationError(code, message, retryable);
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki research evidence map is malformed");
  }
  return value as Record<string, unknown>;
}

function parseEvidenceMap(bytes: Uint8Array): ParsedEvidenceMap {
  let encoded: string;
  let decoded: unknown;
  try {
    encoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    decoded = JSON.parse(encoded);
  } catch {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki research evidence map is malformed");
  }
  const value = object(decoded);
  if (!exactKeys(value, [
     "artifact", "artifact_ref", "coverage_receipt", "coverage_receipt_ref", "dependency_manifest",
     "operation_id", "protocol", "provenance", "sections",
  ]) || value.protocol !== EVIDENCE_MAP_PROTOCOL) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki research evidence map has an invalid contract");
  }
  try {
    if (canonicalEvidenceJson(value) !== encoded) {
      fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki research evidence map is not canonical");
    }
  } catch {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki research evidence map is not canonical");
  }
  const operationId = value.operation_id;
  const artifactRef = VersionedRefSchema.safeParse(value.artifact_ref);
  const artifact = ArtifactRevisionSchema.safeParse(value.artifact);
  const coverageRef = VersionedRefSchema.safeParse(value.coverage_receipt_ref);
  const coverage = CoverageReceiptSchema.safeParse(value.coverage_receipt);
  const provenance = object(value.provenance);
  const dependency = object(value.dependency_manifest);
  if (typeof operationId !== "string" || !IDENTIFIER.test(operationId) || !artifactRef.success ||
      !artifact.success || artifact.data.status !== "DRAFT" || !coverageRef.success || !coverage.success ||
      !Array.isArray(value.sections) || value.sections.length < 1 ||
      value.sections.some((section) => section === null || typeof section !== "object" || Array.isArray(section))) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki research evidence map failed strict validation");
  }
  return {
    protocol: EVIDENCE_MAP_PROTOCOL,
    operation_id: operationId,
    artifact_ref: artifactRef.data,
    artifact: artifact.data,
    coverage_receipt_ref: coverageRef.data,
    coverage_receipt: coverage.data,
    provenance,
    dependency_manifest: dependency,
    sections: value.sections as readonly Record<string, unknown>[],
  };
}

function metadataString(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki research proposal metadata is malformed");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return object(value);
}

function validateAudit(sections: readonly SectionRead[]): { count: number; supported: number; conflicts: number; verifier: string } {
  let auditCount = 0;
  let supported = 0;
  let conflicts = 0;
  let verifier: string | undefined;
  for (const section of sections) {
    const citations = asRecord(section.citations);
    if (citations.semantic_verification !== "EXECUTED") continue;
    const audit = asRecord(citations.audit);
    const claims = audit.claims;
    if (!Array.isArray(claims) || claims.length < 1) {
      fail("WIKI_PUBLICATION_INCOMPLETE", "Wiki research review has no verifiable claim receipt");
    }
    const receipt = citations.verification_receipt_ref;
    if (typeof receipt !== "string" || !IDENTIFIER.test(receipt)) {
      fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki research verifier receipt is malformed");
    }
    verifier ??= receipt;
    auditCount += claims.length;
    for (const rawClaim of claims) {
      const claim = asRecord(rawClaim);
      if (typeof claim.disposition !== "string" ||
          !["SUPPORTED", "PARTIALLY_SUPPORTED", "UNSUPPORTED", "CONTRADICTED", "NOT_VERIFIABLE_IN_SCOPE"].includes(claim.disposition)) {
        fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki research claim disposition is malformed");
      }
      if (claim.disposition === "SUPPORTED") supported += 1;
      if (claim.disposition === "CONTRADICTED") conflicts += 1;
    }
  }
  if (auditCount < 1 || verifier === undefined) {
    fail("WIKI_PUBLICATION_INCOMPLETE", "Wiki research review has no executed claim audit");
  }
  return { count: auditCount, supported, conflicts, verifier };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

async function writeImmutableReceipt(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  digest: string,
): Promise<void> {
  validRef(key, "Wiki review receipt reference");
  try {
    await bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: digest,
      httpMetadata: { contentType: "application/json" },
      customMetadata: { immutable: "true", sha256: digest, size_bytes: String(bytes.byteLength) },
    });
  } catch {
    // The immutable readback below settles conditional collisions and lost puts.
  }
  const observed = await readObject(bucket, key, MAX_MANIFEST_BYTES);
  if (observed.sha256 !== digest || !bytesEqual(observed.bytes, bytes)) {
    fail("WIKI_IMMUTABLE_READBACK_MISMATCH", "Wiki review receipt failed exact readback");
  }
}

async function readOwnerResearchProof(
  env: Env,
  context: AuthenticatedRequestContext,
  operationId: string,
): Promise<{
  readonly artifact: ArtifactRevision;
  readonly historical: NonNullable<Awaited<ReturnType<typeof readHistoricalResearchCoverage>>>;
  readonly dependency: Awaited<ReturnType<typeof readDependencyManifest>>;
  readonly sections: readonly SectionRead[];
}> {
  let reopenedArtifact: ArtifactRevision | undefined;
  const historical = await readHistoricalResearchCoverage({
    database: env.CORE_DB,
    work_bucket: env.WORK_BUCKET,
    operation_id: operationId,
    owner: { principal_ref: context.principal_ref, client_class: "owner_pwa" },
    require_current: () => requireFreshOwnerScope(env, context, operationId),
    require_artifact: async ({ artifact_ref, original_scope_snapshot_ref }) => {
      const reopened = await reopenOwnerArtifactDraft(env, context, artifact_ref);
      if (!("artifact_ref" in reopened.artifact) || "body" in reopened.artifact) {
        fail("WIKI_PROPOSAL_READBACK_MISMATCH", "research artifact readback is incomplete");
      }
      const artifact = reopened.artifact;
      if (artifact.status !== "DRAFT" || !sameRef(artifact.artifact_ref, artifact_ref) ||
          !sameRef(reopened.original_scope_snapshot_ref, original_scope_snapshot_ref)) {
        fail("WIKI_PROPOSAL_READBACK_MISMATCH", "research artifact identity is inconsistent");
      }
      if (reopenedArtifact !== undefined && canonicalEvidenceJson(reopenedArtifact) !== canonicalEvidenceJson(artifact)) {
        fail("WIKI_PROPOSAL_READBACK_MISMATCH", "research artifact changed during readback");
      }
      reopenedArtifact = artifact;
      return {
        artifact_ref: artifact.artifact_ref,
        original_scope_snapshot_ref: reopened.original_scope_snapshot_ref,
        status: "DRAFT" as const,
        evidence_freeze_ref: artifact.evidence_freeze_ref,
        dependency_manifest_ref: artifact.dependency_manifest_ref,
      };
    },
  });
  if (historical === null || reopenedArtifact === undefined) {
    fail("WIKI_PROPOSAL_NOT_FOUND", "completed research draft is unavailable");
  }
  if (!sameRef(historical.artifact_ref, reopenedArtifact.artifact_ref) ||
      !sameRef(historical.coverage_receipt.frozen_scope_snapshot_ref, historical.provenance.original_scope_snapshot_ref)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "research draft and coverage identity differ");
  }
  const dependency = await readDependencyManifest(env, reopenedArtifact);
  const sections: SectionRead[] = [];
  for (const section of reopenedArtifact.sections) {
    sections.push(await readSection(env, context, reopenedArtifact, historical.provenance.original_scope_snapshot_ref, section));
  }
  return { artifact: reopenedArtifact, historical, dependency, sections };
}

/**
 * Derive and persist the owner review admission for a from-run Wiki proposal.
 * A non-from-run proposal returns null and remains on the existing authority path.
 */
export async function admitWikiOwnerReview(
  env: Env,
  context: AuthenticatedRequestContext,
  proposalRef: VersionedRef,
): Promise<WikiOwnerReviewAdmissionResult | null> {
  if (context.client_class !== "owner_pwa") {
    fail("WIKI_POLICY_DENIED", "Wiki review requires an owner session");
  }
  const ref = VersionedRefSchema.safeParse(proposalRef);
  if (!ref.success || ref.data.revision !== 1) fail("WIKI_INPUT_INVALID", "Wiki proposal reference is invalid");
  const row = await loadProposalRow(env.CORE_DB, ref.data, context.principal_ref);
  if (row === null) fail("WIKI_PROPOSAL_NOT_FOUND", "Wiki proposal does not exist");
  const proposal = decodeProposal(row);
  const metadata = asRecord(proposal.page.publication_metadata);
  if (metadata.protocol !== FROM_RUN_PROTOCOL) return null;
  if (proposal.risk_class !== "D2_ANALYTICAL" || proposal.page.page_type !== "Report" ||
      proposal.page.generator_generation !== GENERATOR) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki from-run proposal has an invalid producer binding");
  }
  const operationId = metadataString(metadata, "operation_id");
  const artifactRefKey = metadataString(metadata, "artifact_ref");
  const coverageRefKey = metadataString(metadata, "coverage_receipt_ref");
  const materializeSha = metadataString(metadata, "materialize_output_sha256");
  const proof = await readOwnerResearchProof(env, context, operationId);
  const historical = proof.historical;
  if (!sameRef(proposal.page.scope_snapshot_ref, historical.coverage_receipt.frozen_scope_snapshot_ref) ||
      artifactRefKey !== refKey(proof.artifact.artifact_ref) || coverageRefKey !== refKey(historical.coverage_receipt_ref) ||
      materializeSha !== historical.provenance.materialize_output_sha256 ||
      !sameRef(proposal.page.coverage_receipt_ref, historical.coverage_receipt_ref)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki proposal is not bound to the completed research run");
  }

  const evidenceObject = await readObject(env.WORK_BUCKET, proposal.page.evidence_map_ref, MAX_EVIDENCE_MAP_BYTES);
  if (evidenceObject.sha256 !== row.evidence_map_sha256 || evidenceObject.bytes.byteLength !== row.evidence_map_size) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki evidence map digest differs from its durable identity");
  }
  const evidence = parseEvidenceMap(evidenceObject.bytes);
  if (evidence.operation_id !== operationId || !sameRef(evidence.artifact_ref, proof.artifact.artifact_ref) ||
      !sameRef(evidence.coverage_receipt_ref, historical.coverage_receipt_ref) ||
      canonicalEvidenceJson(evidence.artifact) !== canonicalEvidenceJson(proof.artifact) ||
      canonicalEvidenceJson(evidence.coverage_receipt) !== canonicalEvidenceJson(historical.coverage_receipt) ||
      canonicalEvidenceJson(evidence.provenance) !== canonicalEvidenceJson(historical.provenance) ||
      canonicalEvidenceJson(evidence.dependency_manifest) !== canonicalEvidenceJson(proof.dependency)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki evidence map is not bound to current research readbacks");
  }
  const expectedSections = proof.sections.map(({ text: _text, ...section }) => section);
  if (canonicalEvidenceJson(evidence.sections) !== canonicalEvidenceJson(expectedSections)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki evidence map sections differ from current research readbacks");
  }

  const body = await readObject(env.WORK_BUCKET, proposal.page.body_object_ref, MAX_BODY_BYTES);
  const expectedBody = new TextEncoder().encode(proof.sections.map((section) => section.text).join("\n\n"));
  if (body.sha256 !== proposal.page.body_sha256 || !bytesEqual(body.bytes, expectedBody)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki body differs from current research section readbacks");
  }
  const labels: Record<string, string> = {};
  for (const section of proof.artifact.sections) {
    for (const [claimRef, label] of Object.entries(section.statement_labels)) {
      const key = `${section.section_ref.id}:${section.section_ref.revision}:${claimRef}`;
      if (Object.hasOwn(labels, key)) fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki claim labels are duplicated");
      labels[key] = label;
    }
  }
  if (canonicalEvidenceJson(labels) !== canonicalEvidenceJson(proposal.page.statement_labels)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki statement labels are not bound to the research artifact");
  }
  const audit = validateAudit(proof.sections);
  const coverageComplete = historical.coverage_receipt.denominator_kind === "complete_scope" &&
    (historical.coverage_receipt.terminal_disposition === "ANSWERED_WITH_SUPPORTED_RESULT" ||
      historical.coverage_receipt.terminal_disposition === "NO_MATCH_IN_COMPLETE_SCOPE");
  const conflictCount = audit.conflicts +
    Object.values(proposal.page.statement_labels).filter((label) => label === "CONTESTED").length;
  const requiredDependencies = [
    proof.dependency.object_ref,
    proof.dependency.physical_key,
    refKey(historical.coverage_receipt_ref),
    refKey(proof.artifact.evidence_freeze_ref),
    historical.provenance.coverage_stage_attempt_ref,
    historical.provenance.coverage_stage_request_sha256,
    historical.provenance.coverage_output_sha256,
    historical.provenance.materialize_stage_attempt_ref,
    historical.provenance.materialize_stage_request_sha256,
    historical.provenance.materialize_output_sha256,
    ...proof.artifact.sections.flatMap((section) => [section.body_object_ref, section.evidence_ledger_ref, section.verification_receipt_ref]),
  ];
  const expectedDependencyRefs = [...new Set(requiredDependencies)].sort();
  const actualDependencyRefs = [...proposal.page.dependency_refs].sort();
  if (canonicalEvidenceJson(actualDependencyRefs) !== canonicalEvidenceJson(expectedDependencyRefs) ||
      proposal.page.counterposition_refs.length !== 0 || proposal.page.limitations.length < 1) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki proposal lost a required provenance dependency or limitation");
  }
  await requireFreshOwnerScope(env, context, operationId);

  const existingAuthority = await loadAuthority(env.CORE_DB, row);
  const existingReceiptRef = existingAuthority?.policy_receipt_ref ?? null;
  let admittedAt = new Date().toISOString();
  let existingReceipt: WikiOwnerReviewReceipt | null = null;
  if (existingReceiptRef !== null) {
    const existingObject = await readObject(env.WORK_BUCKET, existingReceiptRef, MAX_MANIFEST_BYTES);
    existingReceipt = decodeWikiOwnerReviewReceipt(existingObject.bytes);
    if (existingReceipt === null) {
      fail("WIKI_PROPOSAL_READBACK_MISMATCH", "existing Wiki review receipt is malformed");
    }
    admittedAt = existingReceipt.admitted_at;
  }
  const receipt: WikiOwnerReviewReceipt = {
    protocol: RECEIPT_PROTOCOL,
    proposal_ref: { ...ref.data },
    page_ref: { ...proposal.page.page_ref },
    principal_ref: context.principal_ref,
    operation_id: operationId,
    artifact_ref: { ...proof.artifact.artifact_ref },
    coverage_receipt_ref: { ...historical.coverage_receipt_ref },
    evidence_receipt_ref: proposal.page.evidence_map_ref,
    dependency_closure_receipt_ref: proof.dependency.object_ref,
    verifier_receipt_ref: audit.verifier,
    coverage_complete: coverageComplete,
    dependency_closure_complete: true,
    conflict_count: conflictCount,
    changes_current_state: false,
    supported_claim_count: audit.supported,
    limitations: [...proposal.page.limitations],
    provenance: { ...historical.provenance } as Record<string, unknown>,
    admitted_at: admittedAt,
  };
  const encodedReceipt = canonicalEvidenceJson(receipt);
  const receiptBytes = new TextEncoder().encode(encodedReceipt);
  const receiptDigest = await sha256(receiptBytes);
  const receiptRef = `wiki/review/${ref.data.id}/${receiptDigest}.json`;
  if (existingReceiptRef !== null && existingReceiptRef !== receiptRef) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "existing Wiki review receipt is bound to different proof");
  }
  await writeImmutableReceipt(env.WORK_BUCKET, receiptRef, receiptBytes, receiptDigest);
  await recordWikiPublicationAuthority(env.CORE_DB, {
    proposal_ref: ref.data,
    principal_ref: context.principal_ref,
    evidence_receipt_ref: receipt.evidence_receipt_ref,
    dependency_closure_receipt_ref: receipt.dependency_closure_receipt_ref,
    verifier_receipt_ref: receipt.verifier_receipt_ref,
    policy_receipt_ref: receiptRef,
    coverage_complete: receipt.coverage_complete,
    dependency_closure_complete: receipt.dependency_closure_complete,
    conflict_count: receipt.conflict_count,
    changes_current_state: receipt.changes_current_state,
    admitted_at: receipt.admitted_at,
  });
  return {
    protocol: RECEIPT_PROTOCOL,
    proposal_ref: { ...ref.data },
    review_receipt_ref: receiptRef,
    coverage_complete: coverageComplete,
    supported_claim_count: audit.supported,
  };
}
