import type { VersionedRef } from "@eliotr/contracts";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import type { D1NavigationStoreInput, EvidenceAccessContext } from "@eliotr/cloudflare-evidence";
import {
  ArtifactPublicationError,
  createArtifactPublicationProducer,
  type ArtifactOwnerAcceptanceDecision,
  type ArtifactPublicationRead,
  type ArtifactPublicationResult,
  type ResolveArtifactAcceptanceDecisionInput,
} from "./artifact-publication.js";
import type { ArtifactDraftReadReauthorization } from "./artifact-draft-read-service.js";

export interface ArtifactPublicationAcceptCommand {
  readonly artifact_ref: VersionedRef;
  readonly expected_draft_head_revision: number;
  readonly expected_publication_revision: number | null;
  readonly idempotency_key: string;
}

export interface ArtifactProductServiceDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly search_database: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly deployment_generation: string;
  readonly access: EvidenceAccessContext;
  readonly now: () => number;
  readonly require_owner: () => void;
  readonly create_require_current: () => D1NavigationStoreInput["require_current"];
  readonly prepare_read_authority: (
    artifact_ref: VersionedRef,
    operation: "report" | "evidence",
  ) => Promise<ArtifactDraftReadReauthorization>;
  readonly stale_current_draft: () => never;
}

function exactRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function createDecisionResolver(
  request: ArtifactPublicationAcceptCommand,
  access: EvidenceAccessContext,
  current: ArtifactDraftReadReauthorization,
): (input: ResolveArtifactAcceptanceDecisionInput) => Promise<ArtifactOwnerAcceptanceDecision> {
  return async (input) => {
    current.requireActiveRequest();
    await current.requireCurrent();
    if (!exactRef(input.artifact_ref, request.artifact_ref) ||
        input.expected_draft_head_revision !== request.expected_draft_head_revision ||
        input.expected_publication_revision !== request.expected_publication_revision ||
        input.access.principal_ref !== access.principal_ref ||
        input.access.credential_generation !== access.credential_generation ||
        input.access.client_class !== "owner_pwa" ||
        input.draft.status !== "DRAFT" || !exactRef(input.draft.artifact_ref, request.artifact_ref)) {
      throw new ArtifactPublicationError(
        "ARTIFACT_PUBLICATION_DENIED",
        "owner acceptance witness does not match the exact authenticated draft request",
      );
    }
    const authorization = input.authorization;
    if (!authorization.allowed_use.includes("research") || authorization.expires_at !== current.authorization.expires_at ||
        authorization.authorization_receipt_ref !== current.authorization.authorization_receipt_ref ||
        authorization.policy_authority_ref !== current.authorization.policy_authority_ref) {
      throw new ArtifactPublicationError(
        "ARTIFACT_PUBLICATION_DENIED",
        "current owner research authorization changed before acceptance",
      );
    }
    const scopeRef = {
      id: current.navigation.scope.snapshot_id,
      revision: current.navigation.scope.revision,
    };
    const expiresAt = authorization.expires_at;
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
      throw new ArtifactPublicationError("ARTIFACT_PUBLICATION_STALE", "owner acceptance authorization has expired");
    }
    const digest = await canonicalDigest({
      protocol: "eliotr.artifact-owner-acceptance.v1",
      mode: "OWNER_EXPLICIT",
      artifact_ref: request.artifact_ref,
      expected_draft_head_revision: request.expected_draft_head_revision,
      expected_publication_revision: request.expected_publication_revision,
      principal_ref: access.principal_ref,
      credential_generation: access.credential_generation,
      idempotency_key: request.idempotency_key,
      scope_ref: scopeRef,
      authorization_receipt_ref: authorization.authorization_receipt_ref,
      policy_authority_ref: authorization.policy_authority_ref,
      expires_at: expiresAt,
    });
    return {
      protocol: "eliotr.artifact-owner-acceptance.v1",
      mode: "OWNER_EXPLICIT",
      artifact_ref: request.artifact_ref,
      expected_draft_head_revision: request.expected_draft_head_revision,
      expected_publication_revision: request.expected_publication_revision,
      principal_ref: access.principal_ref,
      credential_generation: access.credential_generation,
      idempotency_key: request.idempotency_key,
      decision_ref: `artifact-owner-accept-${digest}`,
      provenance_ref: `owner-explicit-accept-${digest}`,
      expires_at: expiresAt,
    };
  };
}

/** Application operations that combine the fresh artifact-read authority with publication policy. */
export function createArtifactProductService(dependencies: ArtifactProductServiceDependencies) {
  function staleCurrentDraft(): never {
    return dependencies.stale_current_draft();
  }

  function producer(
    requireCurrent: D1NavigationStoreInput["require_current"],
    resolveAcceptanceDecision?: (input: ResolveArtifactAcceptanceDecisionInput) => Promise<ArtifactOwnerAcceptanceDecision>,
  ) {
    return createArtifactPublicationProducer({
      database: dependencies.database,
      work_bucket: dependencies.work_bucket,
      require_current: requireCurrent,
      now: dependencies.now,
      ...(resolveAcceptanceDecision === undefined ? {} : { resolve_acceptance_decision: resolveAcceptanceDecision }),
    });
  }

  function publicationAuthority(current: ArtifactDraftReadReauthorization) {
    return {
      access: dependencies.access,
      current_navigation: current.navigation,
      current_authorization: current.authorization,
      search_database: dependencies.search_database,
      evidence_bucket: dependencies.evidence_bucket,
      deployment_generation: dependencies.deployment_generation,
    };
  }

  async function accept(request: ArtifactPublicationAcceptCommand): Promise<ArtifactPublicationResult> {
    dependencies.require_owner();
    const current = await dependencies.prepare_read_authority(request.artifact_ref, "report");
    current.requireActiveRequest();
    await current.requireCurrent();
    const publicationProducer = producer(dependencies.create_require_current(),
      createDecisionResolver(request, dependencies.access, current));
    const result = await publicationProducer.accept({
      ...publicationAuthority(current),
      artifact_ref: request.artifact_ref,
      expected_draft_head_revision: request.expected_draft_head_revision,
      expected_publication_revision: request.expected_publication_revision,
      idempotency_key: request.idempotency_key,
    });
    return result;
  }

  async function read(artifactRef: VersionedRef): Promise<ArtifactPublicationRead> {
    dependencies.require_owner();
    const current = await dependencies.prepare_read_authority(artifactRef, "report");
    current.requireActiveRequest();
    await current.requireCurrent();
    const publication = await producer(dependencies.create_require_current()).read({
      ...publicationAuthority(current),
      artifact_ref: artifactRef,
    });
    if (publication === null) throw new ArtifactPublicationError("ARTIFACT_PUBLICATION_NOT_FOUND", "artifact has no accepted publication");
    return publication;
  }

  async function readCurrent(artifactRef: VersionedRef): Promise<ArtifactPublicationRead> {
    dependencies.require_owner();
    const current = await dependencies.prepare_read_authority(artifactRef, "report");
    current.requireActiveRequest();
    await current.requireCurrent();
    type Head = {
      head_revision: number;
      publication_revision: number | null;
      publication_ref: string | null;
      draft_revision: number | null;
      disposition: string | null;
      receipt_ref: string | null;
    };
    const readHead = () => dependencies.database.prepare(
      "SELECT d.head_revision,h.publication_revision,h.publication_ref,h.draft_revision,h.disposition,p.publication_ref AS receipt_ref " +
      "FROM artifact_draft_head d LEFT JOIN artifact_publication_head h ON h.artifact_id=d.artifact_id " +
      "LEFT JOIN artifact_publication_receipt p ON p.artifact_id=h.artifact_id AND p.draft_revision=h.draft_revision " +
      "AND p.publication_ref=h.publication_ref AND p.publication_revision=h.publication_revision WHERE d.artifact_id=?1",
    ).bind(artifactRef.id).first<Head>();
    const head = await readHead();
    if (head === null || head.head_revision !== artifactRef.revision) staleCurrentDraft();
    if (head.publication_ref === null) {
      current.requireActiveRequest();
      await current.requireCurrent();
      const after = await readHead();
      if (after === null || after.head_revision !== head.head_revision || after.publication_ref !== null ||
          after.publication_revision !== head.publication_revision || after.draft_revision !== head.draft_revision ||
          after.receipt_ref !== head.receipt_ref || after.disposition !== head.disposition) staleCurrentDraft();
      throw new ArtifactPublicationError("ARTIFACT_PUBLICATION_NOT_FOUND", "artifact has no accepted publication");
    }
    if (head.receipt_ref !== head.publication_ref || head.draft_revision === null || head.publication_revision === null) staleCurrentDraft();
    const publication = await read({ id: artifactRef.id, revision: head.draft_revision });
    current.requireActiveRequest();
    await current.requireCurrent();
    const after = await readHead();
    if (after === null || after.head_revision !== head.head_revision || after.publication_ref !== head.publication_ref ||
        after.publication_revision !== head.publication_revision || after.draft_revision !== head.draft_revision ||
        after.receipt_ref !== head.receipt_ref || after.disposition !== head.disposition ||
        publication.receipt.publication_ref !== head.publication_ref ||
        publication.receipt.publication_revision !== head.publication_revision) staleCurrentDraft();
    return publication;
  }

  return { accept, read, readCurrent };
}
