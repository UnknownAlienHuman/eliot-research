import type { ArtifactRevision, ArtifactSpec, ObjectResidencyKey, VersionedRef } from "@eliotr/contracts";
import type { D1NavigationStoreInput, EvidenceAccessContext, NavigationReadAuthority, ScopeAuthorization } from "@eliotr/cloudflare-evidence";
import type { ArtifactDraftReferencedObjectInput, ArtifactDraftSectionInput } from "./artifact-draft-types.js";

export type ArtifactDraftReadErrorCode =
  | "ARTIFACT_DRAFT_READ_INVALID"
  | "ARTIFACT_DRAFT_READ_DENIED"
  | "ARTIFACT_DRAFT_READ_STALE"
  | "ARTIFACT_DRAFT_READ_INTEGRITY"
  | "ARTIFACT_DRAFT_READ_UNAVAILABLE";

export class ArtifactDraftReadError extends Error {
  public readonly code: ArtifactDraftReadErrorCode;
  public readonly status: 400 | 403 | 404 | 409 | 410 | 503;
  public readonly retryable: boolean;

  public constructor(
    code: ArtifactDraftReadErrorCode,
    status: 400 | 403 | 404 | 409 | 410 | 503,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "ArtifactDraftReadError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface ArtifactDraftReadInput {
  /** Server-only W2 materialization readback. Public readers use reauthorization instead. */
  readonly workflow_operation_id?: string;
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly artifact_ref: VersionedRef;
  readonly access: EvidenceAccessContext;
  readonly require_current: D1NavigationStoreInput["require_current"];
  readonly now?: () => number;
}

export interface ArtifactDraftSectionReadInput extends ArtifactDraftReadInput {
  readonly section_ref: VersionedRef;
}

/**
 * Internal dual-scope authorization context. The artifact binding remains
 * attached to its original scope; this navigation authority is only the
 * caller's freshly validated read authorization.
 */
export interface ArtifactDraftReauthorizationContext {
  readonly navigation: NavigationReadAuthority;
  readonly authorization: ScopeAuthorization;
}

export interface ArtifactDraftReauthorizationCoreInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly access: EvidenceAccessContext;
  readonly reauthorization: ArtifactDraftReauthorizationContext;
  readonly now?: () => number;
}

export interface ArtifactDraftReauthorizationSectionReadInput extends ArtifactDraftReauthorizationCoreInput {
  readonly section_ref: VersionedRef;
}

export interface ArtifactDraftSectionRead {
  readonly artifact_ref: VersionedRef;
  readonly section_ref: VersionedRef;
  readonly body_object_ref: string;
  readonly section_ordinal: number;
  readonly body_sha256: string;
  readonly size_bytes: number;
  readonly body: Uint8Array;
}

/** Exact, fully byte-verified DRAFT snapshot used by the internal COW writer. */
export interface ArtifactDraftCowSnapshot {
  readonly spec: ArtifactSpec;
  readonly revision: ArtifactRevision;
  readonly sections: readonly ArtifactDraftSectionInput[];
  readonly referenced_objects: readonly ArtifactDraftReferencedObjectInput[];
  readonly manifest_residency: ObjectResidencyKey;
}

export interface ArtifactDraftReauthorizedCoreRead<T> {
  readonly value: T;
  readonly original_scope_snapshot_ref: VersionedRef;
}

export function failArtifactDraftRead(code: ArtifactDraftReadErrorCode, status: 400 | 403 | 404 | 409 | 410 | 503, message: string, retryable = false): never {
  throw new ArtifactDraftReadError(code, status, message, retryable);
}
