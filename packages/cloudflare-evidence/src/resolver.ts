import {
  CitationResolutionReceiptSchema,
  EvidenceHandleSchema,
  EvidenceResolutionReceiptSchema,
  ResolvedEvidenceSchema,
  type EvidenceHandle,
  type LocatorCandidate,
  type ResolvedEvidence,
  type ScopeSnapshot,
  type VersionedRef,
} from "@eliotr/contracts";
import { validateEvidenceResolution } from "@eliotr/domain";
import {
  assertEvidenceIdentifier,
  canonicalEvidenceJson,
  evidenceRefKey,
  evidenceSha256,
  exactEvidenceRef,
  stableEvidenceId,
} from "./canonical.js";
import {
  evidenceHandleIdentityPayload,
} from "./registry.js";
import {
  EvidenceRuntimeError,
  type CandidateAnchorAuthority,
  type CloudflareEvidenceResolver,
  type EvidenceAccessContext,
  type EvidenceResolverDependencies,
  type EvidenceSourceAuthority,
  type MaterializedEvidenceExcerpt,
  type ScopeAuthority,
  type ScopeAuthorization,
} from "./types.js";

function fail(
  code: EvidenceRuntimeError["code"],
  message: string,
  options: ConstructorParameters<typeof EvidenceRuntimeError>[2] = {},
): never {
  throw new EvidenceRuntimeError(code, message, options);
}

function observedAt(clock: () => number): { readonly epoch: number; readonly iso: string } {
  const epoch = clock();
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    fail("EVIDENCE_INPUT_INVALID", "evidence resolver clock is invalid");
  }
  return { epoch, iso: new Date(epoch).toISOString() };
}

function validateAccess(access: EvidenceAccessContext): void {
  assertEvidenceIdentifier(access.principal_ref, "principal_ref");
  assertEvidenceIdentifier(access.credential_generation, "credential_generation");
  if (
    access.client_class !== "owner_pwa" &&
    access.client_class !== "named_api_client" &&
    access.client_class !== "trusted_agent" &&
    access.client_class !== "federation_client"
  ) {
    fail("EVIDENCE_INPUT_INVALID", "client_class is invalid");
  }
}

async function loadAuthorizedScope(
  dependencies: EvidenceResolverDependencies,
  ref: VersionedRef,
  access: EvidenceAccessContext,
): Promise<{ readonly scope: ScopeAuthority; readonly authorization: ScopeAuthorization }> {
  validateAccess(access);
  const scope = await dependencies.authority.loadScope(ref);
  if (scope === null) fail("EVIDENCE_SCOPE_NOT_FOUND", "ScopeSnapshot does not exist");
  const authorization = await dependencies.authority.authorizeScope(scope, access);
  return { scope, authorization };
}

function requireSourceInScope(
  source: EvidenceSourceAuthority,
  scope: ScopeSnapshot,
  authorization: ScopeAuthorization,
): void {
  if (!scope.member_source_revision_refs.includes(source.source_revision_ref)) {
    fail("EVIDENCE_SCOPE_MISMATCH", "SourceRevision is outside the frozen ScopeSnapshot");
  }
  if (scope.source_owner_generations[source.source_revision_ref] !== source.source_owner_generation) {
    fail("EVIDENCE_OWNER_GENERATION_MISMATCH", "ScopeSnapshot owner generation is stale", {
      invalidation_state: "STALE",
    });
  }
  if (source.allowed_use.some((use) => !authorization.allowed_use.includes(use))) {
    fail("EVIDENCE_AUTHORIZATION_DENIED", "Scope authorization does not admit source allowed-use policy");
  }
  if (source.disclosure_ceiling !== authorization.disclosure_ceiling) {
    fail("EVIDENCE_AUTHORIZATION_DENIED", "source disclosure ceiling differs from scope authorization");
  }
}

function requireLiveSource(source: EvidenceSourceAuthority): void {
  if (source.purge_state === "LIVE") return;
  if (source.purge_state === "RETENTION_BLOCKED") {
    fail("EVIDENCE_SOURCE_NOT_LIVE", "SourceRevision is retention blocked", {
      invalidation_state: "RETENTION_BLOCKED",
    });
  }
  if (source.purge_state === "REDACTED" || source.purge_state === "PURGE_REQUESTED") {
    fail("EVIDENCE_SOURCE_NOT_LIVE", "SourceRevision is redacted or pending purge", {
      invalidation_state: "REDACTED",
    });
  }
  fail("EVIDENCE_SOURCE_NOT_LIVE", "SourceRevision is quarantined", {
    invalidation_state: "STALE",
  });
}

async function loadSource(
  dependencies: EvidenceResolverDependencies,
  sourceRevisionRef: string,
  scope: ScopeAuthority,
  authorization: ScopeAuthorization,
): Promise<EvidenceSourceAuthority> {
  const source = await dependencies.authority.loadSource(sourceRevisionRef);
  if (source === null) fail("EVIDENCE_SOURCE_NOT_FOUND", "SourceRevision does not exist");
  requireLiveSource(source);
  requireSourceInScope(source, scope.snapshot, authorization);
  return source;
}

function expiresAt(
  scope: ScopeAuthority,
  authorization: ScopeAuthorization,
  source: EvidenceSourceAuthority,
): string {
  const values = [
    Date.parse(scope.snapshot.expires_at),
    Date.parse(authorization.expires_at),
    ...(source.admission_expires_at === undefined ? [] : [Date.parse(source.admission_expires_at)]),
  ];
  const minimum = Math.min(...values);
  if (!Number.isSafeInteger(minimum)) fail("EVIDENCE_INPUT_INVALID", "evidence expiry authority is invalid");
  return new Date(minimum).toISOString();
}

async function buildAndPersist(
  dependencies: EvidenceResolverDependencies,
  input: {
    readonly source: EvidenceSourceAuthority;
    readonly scope: ScopeAuthority;
    readonly authorization: ScopeAuthorization;
    readonly access: EvidenceAccessContext;
    readonly anchorAuthority: CandidateAnchorAuthority | {
      readonly anchor: EvidenceHandle["anchor"];
      readonly coordinate_map_ref?: string;
      readonly item_key?: string;
    };
    readonly materialized: MaterializedEvidenceExcerpt;
    readonly existingHandle?: EvidenceHandle;
  },
): Promise<ResolvedEvidence> {
  const now = observedAt(dependencies.now ?? Date.now);
  const handleDraft = EvidenceHandleSchema.parse({
    handle_ref: { id: "evidence-draft", revision: 1 },
    source_namespace_id: input.source.source_namespace_id,
    source_owner_generation: input.source.source_owner_generation,
    source_revision_ref: input.source.source_revision_ref,
    scope_snapshot_ref: {
      id: input.scope.snapshot.snapshot_id,
      revision: input.scope.snapshot.revision,
    },
    anchor: input.anchorAuthority.anchor,
    excerpt_sha256: input.materialized.excerpt_sha256,
    excerpt_byte_length: input.materialized.excerpt_byte_length,
    ...(input.anchorAuthority.coordinate_map_ref === undefined
      ? {}
      : { coordinate_map_ref: input.anchorAuthority.coordinate_map_ref }),
    object_residency_key_digest: input.source.object_residency_key_digest,
    source_assurance_ceiling: input.source.source_assurance_ceiling,
    materializer_assurance_ceiling: "EXACT",
    terminal_state: "LIVE",
    created_at: input.existingHandle?.created_at ?? now.iso,
    expires_at: expiresAt(input.scope, input.authorization, input.source),
  });
  const identityDigest = await evidenceSha256(evidenceHandleIdentityPayload(handleDraft));
  const handleId = await stableEvidenceId("evidence", identityDigest);
  const proposedHandle = EvidenceHandleSchema.parse({
    ...handleDraft,
    handle_ref: { id: handleId, revision: 1 },
  });
  if (input.existingHandle !== undefined && !exactEvidenceRef(input.existingHandle.handle_ref, proposedHandle.handle_ref)) {
    fail("EVIDENCE_IDENTITY_CONFLICT", "existing handle does not match exact materialized identity");
  }
  const anchorDigest = await evidenceSha256(proposedHandle.anchor);
  const receiptId = await stableEvidenceId(
    "evidence-resolution",
    handleId,
    input.authorization.authorization_receipt_ref,
    input.scope.snapshot.digest,
    input.source.content_sha256,
    input.materialized.excerpt_sha256,
    now.iso,
  );
  const receiptDraft = {
    receipt_ref: { id: receiptId, revision: 1 },
    handle_ref: proposedHandle.handle_ref,
    source_revision_ref: input.source.source_revision_ref,
    scope_snapshot_ref: proposedHandle.scope_snapshot_ref,
    authorization_receipt_ref: input.authorization.authorization_receipt_ref,
    normalized_object_ref_digest: input.materialized.normalized_object_ref_digest,
    source_revision_content_sha256: input.source.content_sha256,
    source_object_size: input.materialized.source_object_size,
    scope_snapshot_digest: input.scope.snapshot.digest,
    anchor_digest: anchorDigest,
    excerpt_sha256: input.materialized.excerpt_sha256,
    excerpt_byte_length: input.materialized.excerpt_byte_length,
    source_owner_generation: input.source.source_owner_generation,
    purge_state: "LIVE" as const,
    terminal_state: "LIVE" as const,
    resolved_at: now.iso,
  };
  const receiptDigest = await evidenceSha256(receiptDraft);
  const receipt = EvidenceResolutionReceiptSchema.parse({
    ...receiptDraft,
    receipt_digest: receiptDigest,
  });
  const receiptJson = canonicalEvidenceJson(receipt);
  const persisted = await dependencies.authority.persistResolution({
    proposed_handle: proposedHandle,
    identity_digest: identityDigest,
    resolution_receipt: receipt,
    resolution_receipt_json: receiptJson,
    resolution_receipt_sha256: await evidenceSha256(receipt),
    normalized_object_ref: input.materialized.normalized_object_ref,
    authorization: input.authorization,
    access: input.access,
    scope: input.scope,
    source: input.source,
  });
  const validated = validateEvidenceResolution(persisted.handle, {
    authorized: true,
    currentOwnerGeneration: input.source.source_owner_generation,
    currentPurgeState: input.source.purge_state,
    sourceRevisionRef: input.source.source_revision_ref,
    sourceRevisionDigest: input.source.content_sha256,
    objectResidencyKeyDigest: input.source.object_residency_key_digest,
    excerptDigest: input.materialized.excerpt_sha256,
    excerptByteLength: input.materialized.excerpt_byte_length,
    scopeSnapshotId: input.scope.snapshot.snapshot_id,
    scopeSnapshotRevision: input.scope.snapshot.revision,
    scopeMember: input.scope.snapshot.member_source_revision_refs.includes(input.source.source_revision_ref),
    coordinateMapPresent: persisted.handle.coordinate_map_ref !== undefined,
  });
  if (!validated.ok) {
    fail("EVIDENCE_IDENTITY_CONFLICT", validated.error.message, {
      invalidation_state: validated.error.code === "EVIDENCE_DIGEST_MISMATCH"
        ? "BROKEN_INTEGRITY"
        : "STALE",
    });
  }
  return ResolvedEvidenceSchema.parse({
    handle: persisted.handle,
    exact_excerpt: input.materialized.exact_excerpt,
    ...(input.anchorAuthority.item_key === undefined
      ? {}
      : { neighboring_text_ref: input.anchorAuthority.item_key }),
    source_title: input.source.source_title,
    verification_receipt_ref: evidenceRefKey(persisted.receipt.receipt_ref),
    authorization_receipt_ref: input.authorization.authorization_receipt_ref,
    credential_generation: input.access.credential_generation,
    source_revision_content_sha256: input.source.content_sha256,
    scope_snapshot_digest: input.scope.snapshot.digest,
    instruction_taint: input.source.instruction_taint,
    allowed_effects: input.source.allowed_effects,
    resolved_at: persisted.receipt.resolved_at,
  });
}

async function resolveCandidate(
  dependencies: EvidenceResolverDependencies,
  candidate: LocatorCandidate,
  scopeRef: VersionedRef,
  access: EvidenceAccessContext,
): Promise<ResolvedEvidence> {
  const { scope, authorization } = await loadAuthorizedScope(dependencies, scopeRef, access);
  const source = await loadSource(
    dependencies,
    candidate.source_revision_ref,
    scope,
    authorization,
  );
  const anchorAuthority = await dependencies.authority.resolveCandidate(candidate);
  if (anchorAuthority.content_sha256 !== source.content_sha256) {
    fail("EVIDENCE_LOCATOR_NOT_RESOLVABLE", "projection item digest differs from admitted SourceRevision");
  }
  const materialized = await dependencies.content.materialize(source, anchorAuthority.anchor);
  return buildAndPersist(dependencies, {
    source,
    scope,
    authorization,
    access,
    anchorAuthority,
    materialized,
  });
}

async function resolveHandle(
  dependencies: EvidenceResolverDependencies,
  handleRef: VersionedRef,
  expectedScopeRef: VersionedRef | undefined,
  access: EvidenceAccessContext,
): Promise<ResolvedEvidence> {
  const handle = await dependencies.authority.loadHandle(handleRef);
  if (handle === null) fail("EVIDENCE_HANDLE_NOT_FOUND", "EvidenceHandle does not exist");
  if (handle.terminal_state !== "LIVE") {
    fail("EVIDENCE_HANDLE_NOT_LIVE", "EvidenceHandle is terminal and exposes no content");
  }
  if (expectedScopeRef !== undefined && !exactEvidenceRef(handle.scope_snapshot_ref, expectedScopeRef)) {
    fail("EVIDENCE_SCOPE_MISMATCH", "EvidenceHandle is bound to another ScopeSnapshot");
  }
  const { scope, authorization } = await loadAuthorizedScope(
    dependencies,
    handle.scope_snapshot_ref,
    access,
  );
  const time = observedAt(dependencies.now ?? Date.now);
  if (handle.expires_at !== undefined && Date.parse(handle.expires_at) <= time.epoch) {
    await dependencies.authority.invalidateHandle(handle, "STALE", "EVIDENCE_HANDLE_EXPIRED", time.iso);
    fail("EVIDENCE_HANDLE_NOT_LIVE", "EvidenceHandle expired", { invalidation_state: "STALE" });
  }
  try {
    const source = await loadSource(
      dependencies,
      handle.source_revision_ref,
      scope,
      authorization,
    );
    if (
      source.source_namespace_id !== handle.source_namespace_id ||
      source.source_owner_generation !== handle.source_owner_generation ||
      source.object_residency_key_digest !== handle.object_residency_key_digest
    ) {
      fail("EVIDENCE_OWNER_GENERATION_MISMATCH", "EvidenceHandle source authority changed", {
        invalidation_state: "STALE",
      });
    }
    const materialized = await dependencies.content.materialize(source, handle.anchor);
    if (
      materialized.excerpt_sha256 !== handle.excerpt_sha256 ||
      materialized.excerpt_byte_length !== handle.excerpt_byte_length
    ) {
      fail("EVIDENCE_OBJECT_INTEGRITY", "EvidenceHandle excerpt no longer matches exact bytes", {
        invalidation_state: "BROKEN_INTEGRITY",
      });
    }
    return buildAndPersist(dependencies, {
      source,
      scope,
      authorization,
      access,
      anchorAuthority: {
        anchor: handle.anchor,
        ...(handle.coordinate_map_ref === undefined
          ? {}
          : { coordinate_map_ref: handle.coordinate_map_ref }),
      },
      materialized,
      existingHandle: handle,
    });
  } catch (error) {
    if (error instanceof EvidenceRuntimeError && error.invalidation_state !== undefined) {
      await dependencies.authority.invalidateHandle(
        handle,
        error.invalidation_state,
        error.code,
        time.iso,
      );
    }
    throw error;
  }
}

export function createCloudflareEvidenceResolver(
  dependencies: EvidenceResolverDependencies,
): CloudflareEvidenceResolver {
  return {
    resolveCandidate: (input) => resolveCandidate(
      dependencies,
      input.candidate,
      input.scope_snapshot_ref,
      input.access,
    ),
    resolveHandle: (input) => resolveHandle(
      dependencies,
      input.handle_ref,
      input.expected_scope_snapshot_ref,
      input.access,
    ),
    async resolveCitationSet(input) {
      validateAccess(input.access);
      if (input.handle_refs.length > 512) {
        fail("CITATION_SET_INVALID", "citation set exceeds the hard handle limit");
      }
      const keys = input.handle_refs.map(evidenceRefKey);
      if (new Set(keys).size !== keys.length) {
        fail("CITATION_SET_INVALID", "citation set contains duplicate handles");
      }
      const ordered = [...input.handle_refs].sort((left, right) => (
        evidenceRefKey(left).localeCompare(evidenceRefKey(right))
      ));
      const { scope, authorization } = await loadAuthorizedScope(
        dependencies,
        input.scope_snapshot_ref,
        input.access,
      );
      const resolvedEvidence: ResolvedEvidence[] = [];
      const resolved: {
        handle_ref: VersionedRef;
        excerpt_sha256: string;
        verification_receipt_ref: string;
      }[] = [];
      const rejected: { handle_ref: VersionedRef; reason_code: string }[] = [];
      for (const handleRef of ordered) {
        try {
          const evidence = await resolveHandle(
            dependencies,
            handleRef,
            input.scope_snapshot_ref,
            input.access,
          );
          resolvedEvidence.push(evidence);
          resolved.push({
            handle_ref: evidence.handle.handle_ref,
            excerpt_sha256: evidence.handle.excerpt_sha256,
            verification_receipt_ref: evidence.verification_receipt_ref,
          });
        } catch (error) {
          rejected.push({
            handle_ref: handleRef,
            reason_code: error instanceof EvidenceRuntimeError
              ? error.code
              : "EVIDENCE_SETTLEMENT_UNCERTAIN",
          });
        }
      }
      const time = observedAt(dependencies.now ?? Date.now);
      const identityPayload = {
        scope_snapshot_ref: input.scope_snapshot_ref,
        requested_handle_refs: ordered,
        resolved,
        rejected,
        principal_ref: input.access.principal_ref,
        client_class: input.access.client_class,
        credential_generation: input.access.credential_generation,
        authorization_receipt_ref: authorization.authorization_receipt_ref,
      };
      const identityDigest = await evidenceSha256(identityPayload);
      const receiptDraft = {
        receipt_ref: {
          id: await stableEvidenceId("citation-resolution", identityDigest),
          revision: 1,
        },
        scope_snapshot_ref: input.scope_snapshot_ref,
        requested_handle_refs: ordered,
        resolved,
        rejected,
        requested_count: ordered.length,
        resolved_count: resolved.length,
        all_material_citations_resolved: resolved.length === ordered.length && rejected.length === 0,
        created_at: time.iso,
      };
      const receipt = CitationResolutionReceiptSchema.parse({
        ...receiptDraft,
        receipt_digest: await evidenceSha256(receiptDraft),
      });
      const receiptJson = canonicalEvidenceJson(receipt);
      const persisted = await dependencies.authority.persistCitationReceipt({
        receipt,
        receipt_json: receiptJson,
        receipt_sha256: await evidenceSha256(receipt),
        access: input.access,
        scope,
        authorization,
      });
      return { receipt: persisted, resolved_evidence: resolvedEvidence };
    },
  };
}
