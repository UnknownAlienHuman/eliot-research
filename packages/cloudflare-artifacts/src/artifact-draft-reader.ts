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

function requireDirectReader(input: ArtifactDraftReadInput): void {
  const internalRun = input.workflow_operation_id;
  const serviceRun = (input.access.client_class === "trusted_agent" || input.access.client_class === "named_api_client") &&
    typeof internalRun === "string" && /^run-[0-9a-f]{48}$/u.test(internalRun);
  if (input.access.client_class !== "owner_pwa" && !serviceRun) {
    throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_DENIED", 403, "draft read authorization denied");
  }
}

function mapFailure(error: unknown): never {
  if (error instanceof ArtifactDraftReadError) throw error;
  throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_UNAVAILABLE", 503, "draft read authority is unavailable", true);
}

export async function readArtifactDraft(input: ArtifactDraftReadInput): Promise<ArtifactRevision | null> {
  const artifactRef = validRef(input.artifact_ref, "draft reference");
  requireDirectReader(input);
  try { return await readArtifactDraftInternal(input, artifactRef); }
  catch (error) { return mapFailure(error); }
}

export async function readArtifactDraftSection(input: ArtifactDraftSectionReadInput): Promise<ArtifactDraftSectionRead | null> {
  const artifactRef = validRef(input.artifact_ref, "draft reference");
  const sectionRef = validRef(input.section_ref, "section reference");
  requireDirectReader(input);
  try { return await readArtifactDraftInternal(input, artifactRef, sectionRef); }
  catch (error) { return mapFailure(error); }
}

export async function readArtifactDraftSectionCitations(input: ArtifactDraftSectionReadInput): Promise<ArtifactDraftSectionCitationsRead | null> {
  const artifactRef = validRef(input.artifact_ref, "draft reference");
  const sectionRef = validRef(input.section_ref, "section reference");
  requireDirectReader(input);
  try { return await readArtifactDraftInternal(input, artifactRef, sectionRef, true); }
  catch (error) { return mapFailure(error); }
}
