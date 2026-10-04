import { WorkflowCheckpointStore, type WorkflowRunStatus } from "./store.js";
import { WorkflowCheckpointError, type WorkflowPrincipal } from "./types.js";

export interface RunStatusAuthoritySnapshot {
  readonly investigation_id: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
}
export interface RunStatusReadInput {
  readonly database: D1Database;
  readonly operation_id: string;
  readonly principal: WorkflowPrincipal;
  readonly recheck_authority: () => Promise<RunStatusAuthoritySnapshot>;
}
export async function readResearchRunStatus(input: RunStatusReadInput): Promise<WorkflowRunStatus | null> {
  const store = new WorkflowCheckpointStore(input.database);
  const first = await store.readRunStatus(input.operation_id, input.principal);
  if (first === null) return null;
  if (first.credential_generation !== input.principal.credential_generation ||
      first.deployment_generation !== input.principal.deployment_generation) {
    throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE");
  }
  const before = await input.recheck_authority();
  if (before.investigation_id !== first.investigation_id ||
      before.scope_snapshot_id !== first.scope_snapshot_id ||
      before.scope_snapshot_revision !== first.scope_snapshot_revision) {
    throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
  }
  const status = await store.readRunStatus(input.operation_id, input.principal);
  if (status === null || status.investigation_id !== first.investigation_id ||
      status.scope_snapshot_id !== first.scope_snapshot_id ||
      status.scope_snapshot_revision !== first.scope_snapshot_revision) {
    throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
  }
  const after = await input.recheck_authority();
  if (after.investigation_id !== status.investigation_id ||
      after.scope_snapshot_id !== status.scope_snapshot_id ||
      after.scope_snapshot_revision !== status.scope_snapshot_revision) {
    throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
  }
  return status;
}
