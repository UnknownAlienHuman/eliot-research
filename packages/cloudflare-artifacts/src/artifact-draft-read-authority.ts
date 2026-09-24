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
  /** Internal materialization readback only; independently matched to the canonical W2 run. */
  readonly workflow_operation_id?: string;
}): Promise<boolean> {
  if (input.access.client_class !== "trusted_agent" && input.access.client_class !== "named_api_client") return false;
  const row = await input.database.prepare(
    "SELECT 1 AS authorized FROM scope_access_grant_effective g " +
    "JOIN project_client_grant_current d ON d.grant_id=g.project_client_grant_id AND d.revision=g.project_client_grant_revision " +
    "JOIN artifact_draft_binding b ON b.artifact_id=?8 AND b.revision=?9 " +
    "WHERE g.snapshot_id=?1 AND g.snapshot_revision=?2 AND g.principal_ref=?3 AND g.client_class=?4 " +
    "AND g.credential_generation=?5 AND g.authorization_receipt_ref=?6 AND g.policy_authority_ref=?7 " +
    "AND b.scope_snapshot_id=?10 AND b.scope_snapshot_revision=?11 AND b.principal_ref=?12 " +
    "AND ((?14 IS NULL AND d.grantor_principal_ref=?12 AND g.project_client_operation IN ('report','evidence') " +
    "AND g.project_client_artifact_id=?8 AND g.project_client_artifact_revision=?9 " +
    "AND (?13=0 OR g.project_client_operation='evidence')) OR (g.project_client_operation='run' " +
    "AND b.principal_ref=g.principal_ref AND b.scope_snapshot_id=g.snapshot_id AND b.scope_snapshot_revision=g.snapshot_revision " +
    "AND EXISTS(SELECT 1 FROM research_workflow_current r JOIN research_report_admission a ON a.operation_id=r.operation_id " +
    "WHERE r.operation_id=g.project_client_run_operation_id AND r.principal_ref=g.principal_ref " +
    "AND r.credential_generation=g.credential_generation AND r.scope_snapshot_id=g.snapshot_id " +
    "AND r.scope_snapshot_revision=g.snapshot_revision AND a.intent_id=b.intent_id AND a.intent_revision=b.intent_revision " +
    "AND a.principal_ref=b.principal_ref AND r.state IN ('ACTIVE','ENGINE_COMPLETED') " +
    "AND (?14 IS NULL OR (?14=r.operation_id AND r.next_stage_index>=17))) " +
    "AND (?14 IS NOT NULL OR EXISTS(SELECT 1 FROM json_each(d.record_json,'$.allowed_operations') WHERE value='report')) " +
    "AND (?13=0 OR EXISTS(SELECT 1 FROM json_each(d.record_json,'$.allowed_operations') WHERE value='evidence')))) LIMIT 1",
  ).bind(input.authorization_scope_ref.id, input.authorization_scope_ref.revision,
    input.access.principal_ref, input.access.client_class, input.access.credential_generation,
    input.authorization.authorization_receipt_ref, input.authorization.policy_authority_ref,
    input.artifact_ref.id, input.artifact_ref.revision, input.original_scope_ref.id, input.original_scope_ref.revision,
    input.original_principal_ref, input.citations ? 1 : 0, input.workflow_operation_id ?? null).first<{ authorized: number }>();
  return row?.authorized === 1;
}
