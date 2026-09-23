import type { VersionedRef } from "@eliotr/contracts";
import type { EvidenceAccessContext, ScopeAuthorization } from "@eliotr/cloudflare-evidence";

/** Independently verify the durable artifact origin, not just overlapping source permissions.
 * The effective grant view also fences the current delegation, original project/author,
 * historical membership, expiry and purge state. No artifact or source authority is minted here. */
export async function hasDelegatedArtifactReadAuthority(input: {
  readonly database: D1Database;
  readonly access: EvidenceAccessContext;
  readonly artifact_ref: VersionedRef;
  readonly original_scope_ref: VersionedRef;
  readonly authorization_scope_ref: VersionedRef;
  readonly authorization: ScopeAuthorization;
  readonly original_principal_ref: string;
  readonly citations: boolean;
}): Promise<boolean> {
  if (input.access.client_class !== "trusted_agent" && input.access.client_class !== "named_api_client") return false;
  const row = await input.database.prepare(
    "SELECT 1 AS authorized FROM scope_access_grant_effective g " +
    "JOIN project_client_grant_current d ON d.grant_id=g.project_client_grant_id AND d.revision=g.project_client_grant_revision " +
    "JOIN artifact_draft_binding b ON b.artifact_id=g.project_client_artifact_id AND b.revision=g.project_client_artifact_revision " +
    "WHERE g.snapshot_id=?1 AND g.snapshot_revision=?2 AND g.principal_ref=?3 AND g.client_class=?4 " +
    "AND g.credential_generation=?5 AND g.authorization_receipt_ref=?6 AND g.policy_authority_ref=?7 " +
    "AND g.project_client_artifact_id=?8 AND g.project_client_artifact_revision=?9 " +
    "AND b.scope_snapshot_id=?10 AND b.scope_snapshot_revision=?11 AND b.principal_ref=?12 " +
    "AND d.grantor_principal_ref=?12 AND g.project_client_operation IN ('report','evidence') " +
    "AND (?13=0 OR g.project_client_operation='evidence') LIMIT 1",
  ).bind(input.authorization_scope_ref.id, input.authorization_scope_ref.revision,
    input.access.principal_ref, input.access.client_class, input.access.credential_generation,
    input.authorization.authorization_receipt_ref, input.authorization.policy_authority_ref,
    input.artifact_ref.id, input.artifact_ref.revision, input.original_scope_ref.id, input.original_scope_ref.revision,
    input.original_principal_ref, input.citations ? 1 : 0).first<{ authorized: number }>();
  return row?.authorized === 1;
}
