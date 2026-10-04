import type { EvidenceAccessContext } from "@eliotr/cloudflare-evidence";
import type { VersionedRef } from "@eliotr/contracts";
import type {
  ArtifactDraftReauthorizedRead,
  ArtifactDraftSectionCitationsReauthorizedRead,
} from "@eliotr/cloudflare-research";
import type { SourceRevisionFreshness } from "@eliotr/cloudflare-navigation";

/** Actor fields projected by Core only after the existing request authentication gates pass. */
export type WikiVerifiedActor = EvidenceAccessContext;

export interface WikiDatabaseRuntime {
  readonly database: D1Database;
}

export interface WikiStorageRuntime extends WikiDatabaseRuntime {
  readonly work_bucket: R2Bucket;
}

export interface WikiRuntime extends WikiStorageRuntime {
  readonly deployment_generation: string;
  readonly request_signal: AbortSignal;
  /** Core reauthorization retains access to the original authenticated request and cancellation signal. */
  readonly reopen_owner_artifact_draft: (
    artifact_ref: VersionedRef,
    section_ref?: VersionedRef,
  ) => Promise<WikiReopenedArtifactDraft>;
  readonly reopen_owner_artifact_section_citations: (
    artifact_ref: VersionedRef,
    section_ref: VersionedRef,
  ) => Promise<ArtifactDraftSectionCitationsReauthorizedRead>;
}

export type WikiReopenedArtifactDraft = ArtifactDraftReauthorizedRead |
  (Omit<ArtifactDraftReauthorizedRead, "protocol"> & {
    readonly protocol: "eliotr.artifact-draft-reauthorization.v2";
    readonly source_freshness: SourceRevisionFreshness;
  });
