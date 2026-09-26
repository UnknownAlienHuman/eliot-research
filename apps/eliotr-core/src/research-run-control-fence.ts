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
export const RUN_CONTROL_FENCE_SQL = `(research_workflow_run.operation_id,research_workflow_run.principal_ref,
  research_workflow_run.deployment_generation,research_workflow_run.state)=(?1,?2,?3,'ACTIVE')
  AND ?4 = (SELECT generation FROM investigation_ledger_epoch WHERE singleton=1)
  AND ?5 = (SELECT generation FROM orientation_authority_epoch WHERE singleton=1)
  AND ?6 > CAST(unixepoch('subsec') * 1000 AS INTEGER)
  AND EXISTS (SELECT 1 FROM investigation_ledger_head h
    WHERE (h.investigation_id,h.principal_ref,h.scope_snapshot_id,h.scope_snapshot_revision,h.revision)
      =(research_workflow_run.investigation_id,?2,research_workflow_run.scope_snapshot_id,
        research_workflow_run.scope_snapshot_revision,research_workflow_run.current_revision)
    AND EXISTS (SELECT 1 FROM investigation_current_policy p
      WHERE (p.policy_generation,p.policy_authority_ref,p.state)=(h.policy_generation,h.policy_authority_ref,'ACTIVE')))
  AND ((?11='owner_pwa' AND EXISTS (SELECT 1 FROM scope_snapshot s JOIN scope_access_grant g
    ON (g.snapshot_id,g.snapshot_revision)=(s.snapshot_id,s.revision)
    WHERE (s.snapshot_id,s.revision)=(?7,?8) AND s.invalidated_at IS NULL
      AND julianday(s.expires_at)>julianday('now') AND julianday(g.expires_at)>julianday('now')
      AND (g.state,g.principal_ref,g.client_class,g.credential_generation,g.authorization_receipt_ref,g.policy_authority_ref)
        =('ACTIVE',?16,'owner_pwa',?9,?10,s.policy_authority_ref)
      AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research')
      AND ((?2=?16 AND ?17='') OR EXISTS (SELECT 1 FROM owner_machine_run_origin o
        WHERE (o.operation_id,o.principal_ref,o.reader_principal_ref,o.project_id,o.project_generation,
          o.client_grant_id,o.client_grant_revision)
          =(research_workflow_run.operation_id,?2,?16,?17,?14,?12,?13)))))
    OR (?11 IN ('trusted_agent','named_api_client') AND EXISTS (
      SELECT 1 FROM project_client_run_control_origin c
      WHERE (c.operation_id,c.principal_ref,c.deployment_generation,c.client_grant_id,c.client_grant_revision,
        c.project_generation,c.grantee_issuer,c.grantee_method,c.grantee_subject,c.project_id)
        =(research_workflow_run.operation_id,?2,?3,?12,?13,?14,?15,'service_token',?16,?17)
        AND EXISTS (SELECT 1 FROM json_each(c.grant_record_json,'$.allowed_operations') WHERE value=?18))))
  -- Recovery needs effective execution for service/owner-machine origins; cancellation does not.
  -- The independently reauthenticated original-owner branch retains its existing rule.
  AND (?18='cancel' OR (?11='owner_pwa' AND ?2=?16 AND ?17='')
    OR EXISTS (SELECT 1 FROM research_workflow_current eligible
      WHERE (eligible.operation_id,eligible.state)=(research_workflow_run.operation_id,'ACTIVE')))
  AND NOT EXISTS (SELECT 1 FROM scope_access_grant revoked
    WHERE (revoked.snapshot_id,revoked.snapshot_revision,revoked.principal_ref,revoked.client_class,revoked.state)
      =(research_workflow_run.scope_snapshot_id,research_workflow_run.scope_snapshot_revision,?2,'owner_pwa','REVOKED'))`;

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
