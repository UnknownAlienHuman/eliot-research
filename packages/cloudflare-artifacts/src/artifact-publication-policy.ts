import type { ArtifactRevision, EvidenceLabel } from "@eliotr/contracts";
import type { ArtifactDraftSectionCitationsReauthorizedRead } from "./artifact-draft-citations-reauthorization.js";

export type ArtifactPublicationReadinessCode =
  | "ARTIFACT_PUBLICATION_NOT_DRAFT"
  | "ARTIFACT_PUBLICATION_EMPTY"
  | "ARTIFACT_PUBLICATION_SECTION_UNVERIFIED"
  | "ARTIFACT_PUBLICATION_LABEL_MISMATCH"
  | "ARTIFACT_PUBLICATION_REDACTED_DEPENDENCY";

export class ArtifactPublicationReadinessError extends Error {
  public readonly code: ArtifactPublicationReadinessCode;

  public constructor(code: ArtifactPublicationReadinessCode, message: string) {
    super(message);
    this.name = "ArtifactPublicationReadinessError";
    this.code = code;
  }
}

const LABELS_BY_AUDIT_DISPOSITION: Readonly<Record<string, readonly EvidenceLabel[]>> = {
  SUPPORTED: ["SOURCE_SUPPORTED", "DERIVED_INFERENCE", "EDITORIAL_RECOMMENDATION"],
  PARTIALLY_SUPPORTED: ["CONTESTED", "UNRESOLVED"],
  UNSUPPORTED: ["HYPOTHESIS", "UNRESOLVED"],
  CONTRADICTED: ["CONTESTED"],
  NOT_VERIFIABLE_IN_SCOPE: ["UNRESOLVED"],
};

/**
 * Validate persisted verification authority before any D1 publication write.
 * Citations/currentness are checked separately by the evidence reauthorization
 * reader; this gate ensures its EXECUTED audit actually covers and labels each
 * material statement in the exact draft revision.
 */
export function assertArtifactPublicationReady(
  revision: ArtifactRevision,
  sectionCitations: ReadonlyMap<string, ArtifactDraftSectionCitationsReauthorizedRead>,
): void {
  if (revision.status !== "DRAFT") {
    throw new ArtifactPublicationReadinessError("ARTIFACT_PUBLICATION_NOT_DRAFT", "only an exact DRAFT revision can be accepted");
  }
  if (revision.sections.length === 0 || sectionCitations.size !== revision.sections.length) {
    throw new ArtifactPublicationReadinessError("ARTIFACT_PUBLICATION_EMPTY", "publication requires a verified nonempty section set");
  }

  for (const section of revision.sections) {
    const sectionKey = `${section.section_ref.id}:${section.section_ref.revision}`;
    const verification = sectionCitations.get(sectionKey);
    if (verification === undefined || verification.semantic_verification !== "EXECUTED") {
      throw new ArtifactPublicationReadinessError(
        "ARTIFACT_PUBLICATION_SECTION_UNVERIFIED",
        `section ${section.section_ref.id} has no persisted executed semantic audit`,
      );
    }
    const labelEntries = Object.entries(section.statement_labels);
    if (labelEntries.length === 0 || labelEntries.some(([, label]) => label === "REDACTED_DEPENDENCY")) {
      throw new ArtifactPublicationReadinessError(
        "ARTIFACT_PUBLICATION_REDACTED_DEPENDENCY",
        `section ${section.section_ref.id} has no publishable statement labels or a redacted dependency`,
      );
    }
    const auditClaims = verification.audit.claims;
    if (auditClaims.length !== labelEntries.length) {
      throw new ArtifactPublicationReadinessError(
        "ARTIFACT_PUBLICATION_LABEL_MISMATCH",
        `section ${section.section_ref.id} audit does not cover each labeled statement`,
      );
    }
    const auditByClaimId = new Map(auditClaims.map((claim) => [claim.claim_ref.id, claim]));
    if (auditByClaimId.size !== auditClaims.length) {
      throw new ArtifactPublicationReadinessError(
        "ARTIFACT_PUBLICATION_LABEL_MISMATCH",
        `section ${section.section_ref.id} audit contains duplicate claim identities`,
      );
    }
    for (const [claimId, label] of labelEntries) {
      const claim = auditByClaimId.get(claimId);
      const permittedLabels = claim === undefined ? undefined : LABELS_BY_AUDIT_DISPOSITION[claim.disposition];
      if (claim === undefined || permittedLabels === undefined || !permittedLabels.includes(label)) {
        throw new ArtifactPublicationReadinessError(
          "ARTIFACT_PUBLICATION_LABEL_MISMATCH",
          `section ${section.section_ref.id} audit disposition conflicts with statement label ${claimId}`,
        );
      }
      if (claim.disposition === "CONTRADICTED" && claim.counterevidence_handle_refs.length === 0) {
        throw new ArtifactPublicationReadinessError(
          "ARTIFACT_PUBLICATION_LABEL_MISMATCH",
          `contradicted statement ${claimId} has no counterevidence handle`,
        );
      }
    }
  }
}
