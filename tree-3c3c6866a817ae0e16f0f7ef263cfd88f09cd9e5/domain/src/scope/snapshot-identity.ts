import type { ScopeSnapshot } from "@eliotr/contracts";

export const SCOPE_SNAPSHOT_PROTOCOL = "eliotr.scope-snapshot.v1";
export type ScopeSnapshotMaterial = Omit<ScopeSnapshot, "snapshot_id" | "digest">;

/** The protocol is part of BOTH hashes even though it is not a wire field. */
export function scopeSnapshotIdentityPayload(material: ScopeSnapshotMaterial) {
  return {
    protocol: SCOPE_SNAPSHOT_PROTOCOL,
    revision: material.revision,
    resolved_scope_expression: material.resolved_scope_expression,
    participant_generations: material.participant_generations,
    member_source_revision_refs: material.member_source_revision_refs,
    source_owner_generations: material.source_owner_generations,
    policy_authority_ref: material.policy_authority_ref,
    disclosure_closure_digest: material.disclosure_closure_digest,
    purge_ledger_revision: material.purge_ledger_revision,
    ...(material.client_fence_ref === undefined ? {} : { client_fence_ref: material.client_fence_ref }),
    created_at: material.created_at,
    expires_at: material.expires_at,
  };
}

export function scopeSnapshotDigestPayload(snapshot: ScopeSnapshotMaterial & { readonly snapshot_id: string }) {
  return { snapshot_id: snapshot.snapshot_id, ...scopeSnapshotIdentityPayload(snapshot) };
}

export type ScopeSnapshotPersistenceOutcome = "CREATED" | "REPLAY" | "CONFLICT";
export interface ScopeSnapshotPersistence {
  persistSnapshot(snapshot: ScopeSnapshot): Promise<ScopeSnapshotPersistenceOutcome>;
  readSnapshot(snapshotId: string, revision: number): Promise<ScopeSnapshot | null>;
}
