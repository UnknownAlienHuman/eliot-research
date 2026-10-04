import {
  VersionedRefSchema,
  type ScopeSnapshot,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  createNavigationReadAuthority,
  loadScopeAuthority,
  type EvidenceAccessContext,
  type NavigationReadAuthority,
  type ScopeAuthorization,
} from "@eliotr/cloudflare-evidence";
import {
  readSourceRevisionFreshness,
  reauthorizeOwnerArtifactScope,
  type OwnerHistoricalScopeAuthorization,
} from "@eliotr/cloudflare-navigation";
import { ArtifactDraftReadError } from "./artifact-draft-reader.js";
import { readReauthorizedArtifactDraft } from "./artifact-draft-reauthorization.js";
import { readReauthorizedArtifactDraftSectionCitations } from "./artifact-draft-citations-reauthorization.js";

export interface ArtifactReadClientScopeReauthorizationInput {
  readonly database: D1Database;
  readonly access: EvidenceAccessContext;
  readonly original_ref: VersionedRef;
  readonly original: ScopeSnapshot;
  readonly artifact_ref: VersionedRef;
  readonly original_principal_ref: string;
  readonly operation: "report" | "evidence";
  readonly now: () => number;
}

export type ArtifactReadClientScopeReauthorization = (
  input: ArtifactReadClientScopeReauthorizationInput,
) => Promise<OwnerHistoricalScopeAuthorization>;

export interface ArtifactDraftReadReauthorization {
  readonly artifact_ref: VersionedRef;
  readonly original_scope_snapshot_ref: VersionedRef;
  readonly navigation: NavigationReadAuthority;
  readonly authorization: ScopeAuthorization;
  readonly requireActiveRequest: () => void;
  readonly requireCurrent: () => Promise<void>;
}

export interface ArtifactDraftReadServiceDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly search_database: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly deployment_generation: string;
  readonly reauthorize_client_scope: ArtifactReadClientScopeReauthorization;
}

export interface ArtifactDraftReadRequest {
  readonly access: EvidenceAccessContext;
  readonly artifact_ref: VersionedRef;
  readonly operation: "report" | "evidence";
  readonly require_active_request: () => void;
}

/** Reauthorizes the saved artifact origin, then pins the exact fresh navigation grant for this read. */
export function createArtifactDraftReadService(dependencies: ArtifactDraftReadServiceDependencies) {
  async function prepare(input: ArtifactDraftReadRequest): Promise<ArtifactDraftReadReauthorization | null> {
    if (!["owner_pwa", "trusted_agent", "named_api_client"].includes(input.access.client_class)) {
      throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_DENIED", 403, "Report access is denied");
    }
    const requireActiveRequest = input.require_active_request;
    requireActiveRequest();
    const ref = VersionedRefSchema.parse(input.artifact_ref);
    const binding = await dependencies.database.prepare(
      "SELECT b.scope_snapshot_id,b.scope_snapshot_revision,b.principal_ref FROM artifact_draft_binding b " +
      "JOIN artifact_revision a ON a.artifact_id=b.artifact_id AND a.revision=b.revision " +
      "WHERE b.artifact_id=?1 AND b.revision=?2 AND (?3=0 OR EXISTS (SELECT 1 FROM owner_artifact_read_origin o " +
      "WHERE o.artifact_id=b.artifact_id AND o.artifact_revision=b.revision AND o.reader_principal_ref=?4)) " +
      "AND a.status='DRAFT' LIMIT 1",
    ).bind(ref.id, ref.revision, input.access.client_class === "owner_pwa" ? 1 : 0, input.access.principal_ref)
      .first<{ scope_snapshot_id: string; scope_snapshot_revision: number; principal_ref: string }>();
    if (binding === null) return null;
    const originalScopeRef = VersionedRefSchema.parse({
      id: binding.scope_snapshot_id, revision: binding.scope_snapshot_revision,
    });
    const original = await loadScopeAuthority(dependencies.database, originalScopeRef);
    if (original === null) {
      throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_STALE", 410, "The saved report's sources are no longer available");
    }
    const now = Date.now;
    requireActiveRequest();
    const historicalInput = {
      database: dependencies.database,
      access: input.access,
      original_ref: originalScopeRef,
      original: original.snapshot,
      now,
    };
    const historical = input.access.client_class === "owner_pwa"
      ? await reauthorizeOwnerArtifactScope({
        ...historicalInput,
        artifact_ref: ref,
        original_principal_ref: binding.principal_ref,
      })
      : await dependencies.reauthorize_client_scope({
        ...historicalInput,
        artifact_ref: ref,
        original_principal_ref: binding.principal_ref,
        operation: input.operation,
      });
    requireActiveRequest();
    const navigation = createNavigationReadAuthority({
      database: dependencies.database,
      scope_snapshot: historical.scope,
      access: input.access,
      require_current: historical.requireCurrent,
      now,
    });
    const authorization = await navigation.current();
    const requireCurrent = async (): Promise<void> => {
      requireActiveRequest();
      const currentAuthorization = await navigation.current();
      if (canonicalEvidenceJson(currentAuthorization) !== canonicalEvidenceJson(authorization)) {
        throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_STALE", 410, "The saved report authorization changed during read");
      }
      await navigation.sources(historical.scope.member_source_revision_refs, currentAuthorization);
      if (canonicalEvidenceJson(await navigation.current()) !== canonicalEvidenceJson(authorization)) {
        throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_STALE", 410, "The saved report authorization changed during read");
      }
      await historical.requireCurrent(historical.scope);
      requireActiveRequest();
    };
    return {
      artifact_ref: ref,
      original_scope_snapshot_ref: originalScopeRef,
      navigation,
      authorization,
      requireActiveRequest,
      requireCurrent,
    };
  }

  async function reopen(input: ArtifactDraftReadRequest & { readonly section_ref?: VersionedRef }) {
    const prepared = await prepare(input);
    if (prepared === null) return null;
    const result = await readReauthorizedArtifactDraft({
      database: dependencies.database,
      work_bucket: dependencies.work_bucket,
      artifact_ref: prepared.artifact_ref,
      access: input.access,
      current_navigation: prepared.navigation,
      current_authorization: prepared.authorization,
      deployment_generation: dependencies.deployment_generation,
      ...(input.section_ref === undefined ? {} : { section_ref: VersionedRefSchema.parse(input.section_ref) }),
    });
    prepared.requireActiveRequest();
    if (result === null) return null;
    await prepared.requireCurrent();
    if (input.section_ref !== undefined) return result;
    const sourceFreshness = await readSourceRevisionFreshness(dependencies.database, {
      original_scope_snapshot_ref: prepared.original_scope_snapshot_ref,
      navigation: prepared.navigation,
      requireCurrent: prepared.requireCurrent,
      ...(input.access.client_class === "owner_pwa" ? { owner_artifact_ref: prepared.artifact_ref } : {}),
    });
    return {
      ...result,
      protocol: "eliotr.artifact-draft-reauthorization.v2" as const,
      source_freshness: sourceFreshness,
    };
  }

  async function sectionCitations(input: ArtifactDraftReadRequest & { readonly section_ref: VersionedRef }) {
    const prepared = await prepare({ ...input, operation: "evidence" });
    if (prepared === null) return null;
    const result = await readReauthorizedArtifactDraftSectionCitations({
      database: dependencies.database,
      work_bucket: dependencies.work_bucket,
      search_database: dependencies.search_database,
      evidence_bucket: dependencies.evidence_bucket,
      artifact_ref: prepared.artifact_ref,
      section_ref: VersionedRefSchema.parse(input.section_ref),
      access: input.access,
      current_navigation: prepared.navigation,
      current_authorization: prepared.authorization,
      deployment_generation: dependencies.deployment_generation,
    });
    prepared.requireActiveRequest();
    if (result === null) return null;
    await prepared.requireCurrent();
    return result;
  }

  return { prepare, reopen, sectionCitations };
}
