import { ClientGrantError } from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { ReauthenticatedRunRead } from "./research-run-read-authorization.js";
import type { ProjectClientRunRead } from "./research-client-run-read.js";

export type AuthorizedRunControl = ReauthenticatedRunRead | ProjectClientRunRead;
/** Both owner and service controls reference the same migrated SQL views. */
export async function requireRunControlSchema(database: D1Database): Promise<void> {
  let ready = false;
  try {
    const row = await database.prepare("SELECT value FROM schema_state WHERE key='project_client_run_control_generation'")
      .first<{ readonly value: string }>();
    ready = row?.value === "project-client-run-control-v2";
  } catch { /* Unavailable schema is never permission to dispatch native recovery. */ }
  if (!ready) throw new ClientGrantError("CLIENT_GRANT_SCHEMA_NOT_READY", 503,
    "Migration 0080 is required before Research run controls", true);
}
/** Shared write-time owner/delegation fence, not a new source of authority. */
export const RUN_CONTROL_FENCE_SQL = `operation_id=?1 AND principal_ref=?2 AND deployment_generation=?3 AND state='ACTIVE'
  AND ?4 = (SELECT generation FROM investigation_ledger_epoch WHERE singleton=1)
  AND ?5 = (SELECT generation FROM orientation_authority_epoch WHERE singleton=1)
  AND ?6 > CAST(unixepoch('subsec') * 1000 AS INTEGER)
  AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id=research_workflow_run.investigation_id
    AND h.principal_ref=?2 AND h.scope_snapshot_id=research_workflow_run.scope_snapshot_id
    AND h.scope_snapshot_revision=research_workflow_run.scope_snapshot_revision AND h.revision=research_workflow_run.current_revision
    AND EXISTS (SELECT 1 FROM investigation_current_policy p WHERE p.policy_generation=h.policy_generation
      AND p.policy_authority_ref=h.policy_authority_ref AND p.state='ACTIVE'))
  AND ((?11='owner_pwa' AND EXISTS (SELECT 1 FROM scope_snapshot s JOIN scope_access_grant g
    ON g.snapshot_id=s.snapshot_id AND g.snapshot_revision=s.revision
    WHERE s.snapshot_id=?7 AND s.revision=?8 AND s.invalidated_at IS NULL
    AND julianday(s.expires_at)>julianday('now') AND g.state='ACTIVE'
    AND julianday(g.expires_at)>julianday('now') AND g.principal_ref=?16 AND g.client_class='owner_pwa'
    AND g.credential_generation=?9 AND g.authorization_receipt_ref=?10
    AND g.policy_authority_ref=s.policy_authority_ref
    AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research')
    AND ((?2=?16 AND ?17='') OR EXISTS (SELECT 1 FROM owner_machine_run_origin o
      WHERE o.operation_id=research_workflow_run.operation_id AND o.principal_ref=?2
        AND o.reader_principal_ref=?16 AND o.project_id=?17 AND o.project_generation=?14
        AND o.client_grant_id=?12 AND o.client_grant_revision=?13
        AND (?18='cancel' OR EXISTS (SELECT 1 FROM research_workflow_current eligible
          WHERE eligible.operation_id=o.operation_id AND eligible.state='ACTIVE'))))))
    OR (?11 IN ('trusted_agent','named_api_client') AND EXISTS (
      SELECT 1 FROM project_client_run_control_origin c
      WHERE c.operation_id=research_workflow_run.operation_id AND c.principal_ref=?2
        AND c.deployment_generation=?3 AND c.client_grant_id=?12 AND c.client_grant_revision=?13
        AND c.project_generation=?14 AND c.grantee_issuer=?15
        AND c.grantee_method='service_token' AND c.grantee_subject=?16 AND c.project_id=?17
        AND EXISTS (SELECT 1 FROM json_each(c.grant_record_json,'$.allowed_operations') WHERE value=?18)
        AND (?18='cancel' OR EXISTS (SELECT 1 FROM research_workflow_current eligible
          WHERE eligible.operation_id=c.operation_id AND eligible.state='ACTIVE')))))
  AND NOT EXISTS (SELECT 1 FROM scope_access_grant revoked
    WHERE revoked.snapshot_id=research_workflow_run.scope_snapshot_id
    AND revoked.snapshot_revision=research_workflow_run.scope_snapshot_revision
    AND revoked.principal_ref=?2 AND revoked.client_class='owner_pwa' AND revoked.state='REVOKED')`;

export async function runControlFenceBindings(
  context: AuthenticatedRequestContext, read: AuthorizedRunControl, operation: "cancel" | "recover",
  validUntil = Infinity,
): Promise<readonly (string | number)[]> {
  const fence = await read.controlFence();
  const delegated = "client_grant" in fence ? fence : undefined;
  const owner = "scope_ref" in fence ? fence : undefined;
  const machine = owner?.owner_machine;
  return [read.status.operation_id, read.status.principal_ref, read.status.deployment_generation,
    fence.ledger_epoch, fence.orientation_epoch, Math.min(fence.valid_until_ms, validUntil),
    owner?.scope_ref.id ?? "", owner?.scope_ref.revision ?? 0, context.credential_generation,
    owner?.authorization_receipt_ref ?? "", context.client_class,
    delegated?.client_grant.grant_id ?? machine?.client_grant_id ?? "", delegated?.client_grant.revision ?? machine?.client_grant_revision ?? 0,
    delegated?.project_generation ?? machine?.project_generation ?? 0, context.access?.issuer ?? "", context.principal_ref,
    delegated?.client_grant.project_id ?? machine?.project_id ?? "", operation];
}
