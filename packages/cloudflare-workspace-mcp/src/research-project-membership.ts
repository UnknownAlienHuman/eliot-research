import type { VersionedRef } from "@eliotr/contracts";
import { GeminiMcpToolError } from "./gemini-mcp-tool-common.js";

export interface McpResearchScopeAuthority {
  readonly snapshot: {
    readonly resolved_scope_expression: {
      readonly kind: string;
      readonly project_id?: string;
    };
  };
}

export interface McpResearchProjectMembership {
  require_project_snapshot(scope: { readonly id: string; readonly revision: number }, projectId: string): Promise<void>;
  require_run_project(principalRef: string, workflowInstanceId: string, projectId: string): Promise<void>;
  require_evidence_project(scope: VersionedRef, handle: VersionedRef, projectId: string): Promise<void>;
  require_open_handle_project(handle: VersionedRef, projectId: string): Promise<void>;
}

export interface McpResearchProjectMembershipOptions {
  readonly database: D1Database;
  /** Core binds the already-established scope-authority reader; this module does not create authority. */
  readonly read_scope_authority: (scope: { readonly id: string; readonly revision: number }) =>
    Promise<McpResearchScopeAuthority | null>;
}

/** MCP project/evidence/run membership checks over the exact durable scope bindings. */
export function createMcpResearchProjectMembership(
  options: McpResearchProjectMembershipOptions,
): McpResearchProjectMembership {
  const requireProjectSnapshot = async (
    scopeRef: { readonly id: string; readonly revision: number }, projectId: string,
  ): Promise<void> => {
    const scope = await options.read_scope_authority(scopeRef);
    if (scope?.snapshot.resolved_scope_expression.kind !== "PROJECT" ||
        scope.snapshot.resolved_scope_expression.project_id !== projectId) {
      throw new GeminiMcpToolError("MCP_PROJECT_SCOPE_MISMATCH", "The requested record belongs to another project scope");
    }
  };

  return {
    require_project_snapshot: requireProjectSnapshot,
    async require_run_project(principalRef, workflowInstanceId, projectId) {
      const row = await options.database.prepare(
        "SELECT r.scope_snapshot_id,r.scope_snapshot_revision FROM research_workflow_run r " +
        "WHERE r.operation_id=?1 AND (r.principal_ref=?2 OR EXISTS (SELECT 1 FROM owner_machine_run_origin o " +
        "WHERE o.operation_id=r.operation_id AND o.reader_principal_ref=?2)) LIMIT 1",
      ).bind(workflowInstanceId, principalRef)
        .first<{ scope_snapshot_id: string; scope_snapshot_revision: number }>();
      if (row === null) {
        throw new GeminiMcpToolError("MCP_PROJECT_SCOPE_MISMATCH", "The requested run is unavailable in this project");
      }
      await requireProjectSnapshot({ id: row.scope_snapshot_id, revision: row.scope_snapshot_revision }, projectId);
    },
    async require_evidence_project(scope, handle, projectId) {
      await requireProjectSnapshot(scope, projectId);
      const row = await options.database.prepare(
        "SELECT scope_snapshot_id,scope_snapshot_revision FROM evidence_handle WHERE handle_id=?1 AND revision=?2 LIMIT 1",
      ).bind(handle.id, handle.revision)
        .first<{ scope_snapshot_id: string; scope_snapshot_revision: number }>();
      if (row === null || row.scope_snapshot_id !== scope.id || row.scope_snapshot_revision !== scope.revision) {
        throw new GeminiMcpToolError("MCP_PROJECT_SCOPE_MISMATCH", "The requested evidence is unavailable in this project");
      }
    },
    async require_open_handle_project(handle, projectId) {
      const row = await options.database.prepare(
        "SELECT scope_snapshot_id,scope_snapshot_revision FROM evidence_handle WHERE handle_id=?1 AND revision=?2 LIMIT 1",
      ).bind(handle.id, handle.revision)
        .first<{ scope_snapshot_id: string; scope_snapshot_revision: number }>();
      if (row === null) {
        throw new GeminiMcpToolError("MCP_PROJECT_SCOPE_MISMATCH", "The requested evidence is unavailable in this project");
      }
      await requireProjectSnapshot({ id: row.scope_snapshot_id, revision: row.scope_snapshot_revision }, projectId);
    },
  };
}
