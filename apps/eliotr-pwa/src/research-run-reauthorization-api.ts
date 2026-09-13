import { IdentifierSchema, type VersionedRef } from "@eliotr/contracts";
import { requestApi } from "./api.js";
import {
  boundedString,
  checkGeneration,
  decodeCitationAudit,
  envelope,
  identifier,
  invalid,
  record,
  sameRef,
  scopeAuthorization,
  sha256Digest,
  versionedRef,
  type ResearchArtifactSectionCitationAudit,
  type ResearchScopeAuthorizationView,
} from "./research-run-api.js";

export interface ResearchArtifactSectionCitationReauthorized {
  readonly original_handle_ref: VersionedRef;
  readonly handle_ref: VersionedRef;
  readonly excerpt_sha256: string;
}

interface ResearchArtifactSectionCitationsReauthorizedBase {
  readonly protocol: "eliotr.artifact-draft-citations-reauthorization.v1";
  readonly artifact_ref: VersionedRef;
  readonly section_ref: VersionedRef;
  readonly original_scope_snapshot_ref: VersionedRef;
  readonly authorization_scope_snapshot_ref: VersionedRef;
  readonly authorization: ResearchScopeAuthorizationView;
  readonly deployment_generation: string;
  readonly verification_receipt_ref: string;
  readonly cited_evidence: readonly ResearchArtifactSectionCitationReauthorized[];
}

export type ResearchArtifactSectionCitationsReauthorizedView =
  | (ResearchArtifactSectionCitationsReauthorizedBase & { readonly semantic_verification: "NOT_EXECUTED"; readonly audit?: never })
  | (ResearchArtifactSectionCitationsReauthorizedBase & { readonly semantic_verification: "EXECUTED"; readonly audit: ResearchArtifactSectionCitationAudit });

export function decodeResearchArtifactSectionCitationsReauthorized(
  raw: unknown,
  expectedArtifact: VersionedRef,
  expectedSection: VersionedRef,
  expectedDeploymentGeneration?: string,
  expectedVerificationReceiptRef?: string,
): ResearchArtifactSectionCitationsReauthorizedView {
  const parsed = envelope(raw); checkGeneration(parsed.deployment_generation, expectedDeploymentGeneration);
  const data = record(parsed.data, ["protocol", "artifact_ref", "section_ref", "original_scope_snapshot_ref", "authorization_scope_snapshot_ref", "authorization", "deployment_generation", "verification_receipt_ref", "cited_evidence", "semantic_verification"], ["audit"]);
  if (data.protocol !== "eliotr.artifact-draft-citations-reauthorization.v1") invalid("artifact citation reauthorization protocol is invalid");
  const artifact = versionedRef(data.artifact_ref, "artifact_ref"); const section = versionedRef(data.section_ref, "section_ref");
  if (!sameRef(artifact, expectedArtifact) || !sameRef(section, expectedSection)) invalid("reauthorized citation identity does not match the requested section");
  const generation = identifier(data.deployment_generation, "data.deployment_generation");
  if (generation !== parsed.deployment_generation) invalid("reauthorized citation generations differ");
  const receipt = boundedString(data.verification_receipt_ref, "verification_receipt_ref");
  if (!IdentifierSchema.safeParse(receipt).success || (expectedVerificationReceiptRef !== undefined && receipt !== expectedVerificationReceiptRef)) invalid("reauthorized citation receipt is invalid");
  if (!Array.isArray(data.cited_evidence) || data.cited_evidence.length > 512) invalid("reauthorized cited evidence is invalid");
  const originalSeen = new Set<string>(); const freshSeen = new Set<string>();
  const citedEvidence = data.cited_evidence.map((value, index) => {
    const citation = record(value, ["original_handle_ref", "handle_ref", "excerpt_sha256"]);
    const original = versionedRef(citation.original_handle_ref, `cited_evidence[${index}].original_handle_ref`);
    const fresh = versionedRef(citation.handle_ref, `cited_evidence[${index}].handle_ref`);
    const originalKey = `${original.id}:${original.revision}`; const freshKey = `${fresh.id}:${fresh.revision}`;
    if (originalSeen.has(originalKey) || freshSeen.has(freshKey)) invalid("reauthorized cited evidence contains a duplicate handle");
    originalSeen.add(originalKey); freshSeen.add(freshKey);
    return { original_handle_ref: original, handle_ref: fresh, excerpt_sha256: sha256Digest(citation.excerpt_sha256, `cited_evidence[${index}].excerpt_sha256`) };
  });
  const base = { protocol: "eliotr.artifact-draft-citations-reauthorization.v1" as const, artifact_ref: artifact, section_ref: section, original_scope_snapshot_ref: versionedRef(data.original_scope_snapshot_ref, "original_scope_snapshot_ref"), authorization_scope_snapshot_ref: versionedRef(data.authorization_scope_snapshot_ref, "authorization_scope_snapshot_ref"), authorization: scopeAuthorization(data.authorization), deployment_generation: generation, verification_receipt_ref: receipt, cited_evidence: citedEvidence };
  if (data.semantic_verification === "NOT_EXECUTED" && !Object.hasOwn(data, "audit")) return { ...base, semantic_verification: "NOT_EXECUTED" };
  if (data.semantic_verification === "EXECUTED" && Object.hasOwn(data, "audit")) {
    const audit = decodeCitationAudit(data.audit);
    for (const claim of audit.claims) for (const ref of [...claim.support_handle_refs, ...claim.counterevidence_handle_refs]) if (!originalSeen.has(`${ref.id}:${ref.revision}`)) invalid("reauthorized audit evidence is not present in cited_evidence");
    return { ...base, semantic_verification: "EXECUTED", audit };
  }
  invalid("reauthorized citation semantic verification is invalid");
}

export async function readReauthorizedResearchArtifactSectionCitations(
  artifactRef: { readonly id: string; readonly revision: number },
  sectionRef: { readonly id: string; readonly revision: number },
  expectedDeploymentGeneration?: string,
  signal?: AbortSignal,
  expectedVerificationReceiptRef?: string,
): Promise<ResearchArtifactSectionCitationsReauthorizedView> {
  const artifact = versionedRef(artifactRef, "artifact_ref"); const section = versionedRef(sectionRef, "section_ref");
  const path = `/api/v1/research/artifact/${encodeURIComponent(`${artifact.id}:${artifact.revision}`)}/sections/${encodeURIComponent(`${section.id}:${section.revision}`)}/citations/reauthorize`;
  const raw = await requestApi(path, { method: "POST", ...(signal === undefined ? {} : { signal }) });
  return decodeResearchArtifactSectionCitationsReauthorized(raw, artifact, section, expectedDeploymentGeneration, expectedVerificationReceiptRef);
}
