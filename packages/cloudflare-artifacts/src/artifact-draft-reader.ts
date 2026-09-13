import {
  ArtifactDraftReadError,
  readArtifactDraftInternal,
  type ArtifactDraftReadInput,
  type ArtifactDraftSectionCitationsRead,
  type ArtifactDraftSectionRead,
  type ArtifactDraftSectionReadInput,
} from "./artifact-draft-reader-core.js";
import { VersionedRefSchema, type ArtifactRevision, type VersionedRef } from "@eliotr/contracts";

export {
  ArtifactDraftReadError,
  type ArtifactDraftReadErrorCode,
  type ArtifactDraftReadInput,
  type ArtifactDraftSectionCitationsRead,
  type ArtifactDraftSectionRead,
  type ArtifactDraftSectionReadInput,
} from "./artifact-draft-reader-core.js";
export {
  ArtifactDraftSectionCitationsError,
  type ArtifactDraftSectionCitationsContext,
} from "./artifact-draft-citations-reader.js";
export type {
  ArtifactDraftSemanticAudit,
  ArtifactDraftSemanticAuditClaim,
  ArtifactDraftVerificationAnyEncoded,
  ArtifactDraftVerificationCitation,
  ArtifactDraftVerificationEncoded,
  ArtifactDraftVerificationRecord,
  ArtifactDraftVerificationV2Encoded,
  ArtifactDraftVerificationV2Record,
} from "./artifact-draft-verification.js";

function validRef(value: unknown, label: string): VersionedRef {
  try { return VersionedRefSchema.parse(value); }
  catch { throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_INVALID", 400, `${label} is invalid`); }
}

function ownerOnly(input: ArtifactDraftReadInput): void {
  if (input.access.client_class !== "owner_pwa") {
    throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_DENIED", 403, "draft read authorization denied");
  }
}

function mapFailure(error: unknown): never {
  if (error instanceof ArtifactDraftReadError) throw error;
  throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_UNAVAILABLE", 503, "draft read authority is unavailable", true);
}

export async function readArtifactDraft(input: ArtifactDraftReadInput): Promise<ArtifactRevision | null> {
  const artifactRef = validRef(input.artifact_ref, "draft reference");
  ownerOnly(input);
  try { return await readArtifactDraftInternal(input, artifactRef); }
  catch (error) { return mapFailure(error); }
}

export async function readArtifactDraftSection(input: ArtifactDraftSectionReadInput): Promise<ArtifactDraftSectionRead | null> {
  const artifactRef = validRef(input.artifact_ref, "draft reference");
  const sectionRef = validRef(input.section_ref, "section reference");
  ownerOnly(input);
  try { return await readArtifactDraftInternal(input, artifactRef, sectionRef); }
  catch (error) { return mapFailure(error); }
}

export async function readArtifactDraftSectionCitations(input: ArtifactDraftSectionReadInput): Promise<ArtifactDraftSectionCitationsRead | null> {
  const artifactRef = validRef(input.artifact_ref, "draft reference");
  const sectionRef = validRef(input.section_ref, "section reference");
  ownerOnly(input);
  try { return await readArtifactDraftInternal(input, artifactRef, sectionRef, true); }
  catch (error) { return mapFailure(error); }
}
