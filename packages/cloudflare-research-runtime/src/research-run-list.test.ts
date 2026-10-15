import { describe, expect, it } from "vitest";
import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
import { readOwnerResearchRuns, type ResearchRunListPorts } from "./research-run-list.js";
import type { ResearchRunReadEnvironment } from "./research-run-read-authorization.js";

describe("owner research history without a ledger row", () => {
  it("keeps rows without a ledger and returns the exact query when one exists", async () => {
    let historySql = "";
    const question = "How did the saved source revisions change this evidence?";
    const database = {
      prepare(query: string) {
        return {
          bind(..._values: unknown[]) {
            return {
              all: async <T>() => {
                if (query.includes("FROM research_workflow_run r") && query.includes("h.goal AS query")) {
                  historySql = query;
                  return { success: true, results: [
                    { operation_id: "current-run", created_at: "2026-10-15T12:01:00.000Z", query: question },
                    { operation_id: "legacy-run", created_at: "2026-10-15T12:00:00.000Z", query: null },
                  ] as T[] };
                }
                return { success: true, results: [] as T[] };
              },
              first: async () => null,
            };
          },
        };
      },
    } as unknown as D1Database;
    const status = {
      protocol: "eliotr.research-run-status.v1",
      workflow_instance_id: "legacy-run",
      investigation_ref: { id: "investigation-legacy", revision: 1 },
      execution_state: "ENGINE_COMPLETED",
      engine_status: "complete",
      next_stage_index: 18,
      answer: { availability: "unavailable" },
    } as unknown as ResearchRunStatus;
    const ports = {
      database,
      work_bucket: {} as R2Bucket,
      deployment_generation: "deployment-1",
      run_read: { database } as ResearchRunReadEnvironment,
      authorize_owner_read: () => undefined,
      run_status: async (_context, operation_id) => ({ ...status, workflow_instance_id: operation_id } as ResearchRunStatus),
      prepare_artifact_read: async () => { throw new Error("no saved draft expected"); },
      reopen_owner_artifact_draft: async () => { throw new Error("no saved draft expected"); },
      semantic_configuration_installed: () => true,
    } satisfies ResearchRunListPorts;
    const context = {
      principal_ref: "owner-1",
      client_class: "owner_pwa",
      credential_generation: "credential-1",
      request: new Request("https://owner.invalid/api/v1/research/runs"),
    } as unknown as AuthenticatedRequestContext;

    const history = await readOwnerResearchRuns(ports, context);

    expect(historySql).toContain("LEFT JOIN investigation_ledger_head");
    expect(history.runs).toHaveLength(2);
    expect(history.runs[0]).toMatchObject({ created_at: "2026-10-15T12:01:00.000Z", query: question });
    expect(history.runs[1]).toMatchObject({ created_at: "2026-10-15T12:00:00.000Z", status });
    expect(history.runs[1]).not.toHaveProperty("query");
  });
});
