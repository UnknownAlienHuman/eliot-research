import { describe, expect, it, vi } from "vitest";
import type { VersionedRef } from "@eliotr/contracts";
import {
  createMcpResearchProjectMembership,
  type McpResearchScopeAuthority,
} from "@eliotr/cloudflare-workspace-mcp/research-project-membership.js";

interface RunRow {
  readonly operation_id: string;
  readonly principal_ref: string;
  readonly reader_principal_ref?: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
}

interface HandleRow {
  readonly handle_id: string;
  readonly revision: number;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
}

interface QueryRecord {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

function membershipFixture(runs: readonly RunRow[], handles: readonly HandleRow[]) {
  const queries: QueryRecord[] = [];
  const database = {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          queries.push({ sql, bindings });
          return {
            async first<T>(): Promise<T | null> {
              let row: unknown = null;
              if (sql.startsWith("SELECT r.scope_snapshot_id,r.scope_snapshot_revision FROM research_workflow_run")) {
                const [operationId, principalRef] = bindings;
                const run = runs.find((candidate) => candidate.operation_id === operationId &&
                  (candidate.principal_ref === principalRef || candidate.reader_principal_ref === principalRef));
                if (run !== undefined) {
                  row = { scope_snapshot_id: run.scope_snapshot_id, scope_snapshot_revision: run.scope_snapshot_revision };
                }
              } else if (sql.startsWith("SELECT scope_snapshot_id,scope_snapshot_revision FROM evidence_handle")) {
                const [handleId, revision] = bindings;
                const handle = handles.find((candidate) => candidate.handle_id === handleId && candidate.revision === revision);
                if (handle !== undefined) {
                  row = { scope_snapshot_id: handle.scope_snapshot_id, scope_snapshot_revision: handle.scope_snapshot_revision };
                }
              } else {
                throw new Error("Unexpected MCP membership query");
              }
              return row as T | null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { database, queries };
}

function scopeAuthorityFixture(projectByScope: ReadonlyMap<string, string>) {
  return vi.fn(async (scope: { readonly id: string; readonly revision: number }): Promise<McpResearchScopeAuthority | null> => {
    const projectId = projectByScope.get(`${scope.id}#${scope.revision}`);
    if (projectId === undefined) return null;
    return { snapshot: { resolved_scope_expression: { kind: "PROJECT", project_id: projectId } } };
  });
}

const RUN_OWNER = "alice@example.com";
const RUN_ID = "run-membership-1";
const SCOPE_A: VersionedRef = { id: "scope-a", revision: 7 };
const SCOPE_B: VersionedRef = { id: "scope-b", revision: 3 };
const HANDLE_A: VersionedRef = { id: "handle-a", revision: 2 };
const HANDLE_B: VersionedRef = { id: "handle-b", revision: 5 };

describe("MCP research project membership", () => {
  it("binds run and evidence checks to exact scope id/revision DTOs", async () => {
    const { database, queries } = membershipFixture([
      { operation_id: RUN_ID, principal_ref: RUN_OWNER, scope_snapshot_id: SCOPE_A.id,
        scope_snapshot_revision: SCOPE_A.revision },
    ], [
      { handle_id: HANDLE_A.id, revision: HANDLE_A.revision, scope_snapshot_id: SCOPE_A.id,
        scope_snapshot_revision: SCOPE_A.revision },
    ]);
    const readScopeAuthority = scopeAuthorityFixture(new Map([["scope-a#7", "project-a"]]));
    const membership = createMcpResearchProjectMembership({ database, read_scope_authority: readScopeAuthority });

    await membership.require_run_project(RUN_OWNER, RUN_ID, "project-a");
    await membership.require_evidence_project(SCOPE_A, HANDLE_A, "project-a");
    await membership.require_open_handle_project(HANDLE_A, "project-a");

    expect(queries.map(({ bindings }) => bindings)).toEqual([
      [RUN_ID, RUN_OWNER], [HANDLE_A.id, HANDLE_A.revision], [HANDLE_A.id, HANDLE_A.revision],
    ]);
    expect(readScopeAuthority.mock.calls.map(([scope]) => scope)).toEqual([SCOPE_A, SCOPE_A, SCOPE_A]);
  });

  it("denies foreign owners, foreign project scopes, mismatched evidence scopes, and missing authority", async () => {
    const { database } = membershipFixture([
      { operation_id: RUN_ID, principal_ref: RUN_OWNER, scope_snapshot_id: SCOPE_A.id,
        scope_snapshot_revision: SCOPE_A.revision },
    ], [
      { handle_id: HANDLE_A.id, revision: HANDLE_A.revision, scope_snapshot_id: SCOPE_A.id,
        scope_snapshot_revision: SCOPE_A.revision },
      { handle_id: HANDLE_B.id, revision: HANDLE_B.revision, scope_snapshot_id: SCOPE_B.id,
        scope_snapshot_revision: SCOPE_B.revision },
    ]);
    const readScopeAuthority = scopeAuthorityFixture(new Map([
      ["scope-a#7", "project-a"], ["scope-b#3", "project-b"],
    ]));
    const membership = createMcpResearchProjectMembership({ database, read_scope_authority: readScopeAuthority });

    await expect(membership.require_run_project("mallory@example.com", RUN_ID, "project-a"))
      .rejects.toMatchObject({ code: "MCP_PROJECT_SCOPE_MISMATCH" });
    await expect(membership.require_run_project(RUN_OWNER, RUN_ID, "project-b"))
      .rejects.toMatchObject({ code: "MCP_PROJECT_SCOPE_MISMATCH" });
    await expect(membership.require_evidence_project(SCOPE_A, HANDLE_B, "project-a"))
      .rejects.toMatchObject({ code: "MCP_PROJECT_SCOPE_MISMATCH" });
    await expect(membership.require_open_handle_project(HANDLE_B, "project-a"))
      .rejects.toMatchObject({ code: "MCP_PROJECT_SCOPE_MISMATCH" });
    await expect(membership.require_project_snapshot({ id: "unknown-scope", revision: 1 }, "project-a"))
      .rejects.toMatchObject({ code: "MCP_PROJECT_SCOPE_MISMATCH" });
  });
});
