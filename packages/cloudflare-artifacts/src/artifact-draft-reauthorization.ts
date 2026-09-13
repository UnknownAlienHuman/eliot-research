import {
  ScopeSnapshotSchema,
  VersionedRefSchema,
  type ArtifactRevision,
  type ScopeSnapshot,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  type EvidenceAccessContext,
  type NavigationReadAuthority,
  type ScopeAuthorization,
} from "@eliotr/cloudflare-evidence";
import {
  ArtifactDraftReadError,
  readArtifactDraftReauthorizedInternal,
  type ArtifactDraftReauthorizedCoreRead,
  type ArtifactDraftSectionRead,
} from "./artifact-draft-reader-core.js";

export const ARTIFACT_DRAFT_REAUTHORIZATION_PROTOCOL = "eliotr.artifact-draft-reauthorization.v1" as const;

export interface ArtifactDraftReauthorizationInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly artifact_ref: VersionedRef;
  readonly access: EvidenceAccessContext;
  /** A newly created, owner-authorized navigation scope for this read. */
  readonly current_navigation: NavigationReadAuthority;
  /** The exact grant returned by current_navigation.current(). */
  readonly current_authorization: ScopeAuthorization;
  readonly deployment_generation: string;
  readonly section_ref?: VersionedRef;
}

export interface ArtifactDraftReauthorizedRead {
  readonly protocol: typeof ARTIFACT_DRAFT_REAUTHORIZATION_PROTOCOL;
  readonly artifact_ref: VersionedRef;
  readonly artifact: ArtifactRevision | ArtifactDraftSectionRead;
  readonly original_scope_snapshot_ref: VersionedRef;
  readonly authorization_scope_snapshot_ref: VersionedRef;
  readonly authorization: ScopeAuthorization;
  readonly deployment_generation: string;
}

function invalid(message: string): never {
  throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_INVALID", 400, message);
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value) invalid(`${label} is invalid`);
  return value;
}

function parseRef(value: unknown, label: string): VersionedRef {
  try { return VersionedRefSchema.parse(value); }
  catch { invalid(`${label} is invalid`); }
}

function cloneAuthorization(value: unknown): ScopeAuthorization {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("current authorization is invalid");
  const candidate = value as Record<string, unknown>;
  const keys = ["authorization_receipt_ref", "policy_authority_ref", "allowed_use", "disclosure_ceiling", "expires_at"];
  if (Object.keys(candidate).some((key) => !keys.includes(key)) || Object.keys(candidate).length !== keys.length ||
      typeof candidate.authorization_receipt_ref !== "string" || typeof candidate.policy_authority_ref !== "string" ||
      !Array.isArray(candidate.allowed_use) || candidate.allowed_use.some((use) => typeof use !== "string") ||
      typeof candidate.disclosure_ceiling !== "string" || typeof candidate.expires_at !== "string" ||
      !Number.isFinite(Date.parse(candidate.expires_at))) {
    invalid("current authorization is invalid");
  }
  return JSON.parse(JSON.stringify(candidate)) as ScopeAuthorization;
}

function sameAccess(left: EvidenceAccessContext, right: EvidenceAccessContext): boolean {
  return left.principal_ref === right.principal_ref && left.client_class === right.client_class &&
    left.credential_generation === right.credential_generation;
}

export async function readReauthorizedArtifactDraft(
  input: ArtifactDraftReauthorizationInput,
): Promise<ArtifactDraftReauthorizedRead | null> {
  const artifactRef = parseRef(input.artifact_ref, "draft reference");
  const sectionRef = input.section_ref === undefined ? undefined : parseRef(input.section_ref, "section reference");
  if (input.access.client_class !== "owner_pwa") {
    throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_DENIED", 403, "draft read authorization denied");
  }
  boundedString(input.access.principal_ref, "principal");
  boundedString(input.access.credential_generation, "credential generation");
  const deploymentGeneration = boundedString(input.deployment_generation, "deployment generation");
  if (input.current_navigation === null || typeof input.current_navigation !== "object" ||
      typeof input.current_navigation.current !== "function" || typeof input.current_navigation.sources !== "function") {
    invalid("current navigation authority is invalid");
  }
  if (!sameAccess(input.access, input.current_navigation.access) || input.current_navigation.access.client_class !== "owner_pwa") {
    throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_DENIED", 403, "draft read authorization denied");
  }
  let currentScope: ScopeSnapshot;
  try { currentScope = ScopeSnapshotSchema.parse(input.current_navigation.scope); }
  catch { invalid("current navigation scope is invalid"); }
  const authorization = cloneAuthorization(input.current_authorization);
  const authorizationScopeRef = parseRef({ id: currentScope.snapshot_id, revision: currentScope.revision }, "authorization scope");
  const coreInput = {
    database: input.database,
    work_bucket: input.work_bucket,
    access: input.access,
    reauthorization: {
      navigation: input.current_navigation,
      authorization,
    },
  } as const;
  let read: ArtifactDraftReauthorizedCoreRead<ArtifactRevision | ArtifactDraftSectionRead> | null;
  try {
    read = sectionRef === undefined
      ? await readArtifactDraftReauthorizedInternal(coreInput, artifactRef)
      : await readArtifactDraftReauthorizedInternal({ ...coreInput, section_ref: sectionRef }, artifactRef, sectionRef);
  } catch (error) {
    if (error instanceof ArtifactDraftReadError) throw error;
    throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_UNAVAILABLE", 503, "draft read authority is unavailable", true);
  }
  if (read === null) return null;
  const originalScopeRef = parseRef(read.original_scope_snapshot_ref, "original scope");
  return {
    protocol: ARTIFACT_DRAFT_REAUTHORIZATION_PROTOCOL,
    artifact_ref: artifactRef,
    artifact: read.value,
    original_scope_snapshot_ref: originalScopeRef,
    authorization_scope_snapshot_ref: authorizationScopeRef,
    authorization,
    deployment_generation: deploymentGeneration,
  };
}
